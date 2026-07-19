const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const dgram = require('dgram');

const app = express();
const PORT = process.env.PORT || 3000;
const CONFIG_FILE = path.join(__dirname, 'config.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configuración en memoria
let tvConfig = {
  ip: '',
  apiVersion: 1, // 1 o 6
  port: 1925,
  username: '',
  password: '',
  authRequired: false,
  mac: '',
  deviceId: 'antigravity-remote-' + crypto.randomBytes(4).toString('hex')
};

// Cargar configuración guardada
if (fs.existsSync(CONFIG_FILE)) {
  try {
    const savedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    tvConfig = { ...tvConfig, ...savedConfig };
    console.log('Configuración cargada:', {
      ip: tvConfig.ip,
      apiVersion: tvConfig.apiVersion,
      port: tvConfig.port,
      authRequired: tvConfig.authRequired,
      mac: tvConfig.mac,
      hasCredentials: !!tvConfig.password
    });
  } catch (err) {
    console.error('Error al cargar config.json:', err);
  }
}

// Variables temporales para el flujo de emparejamiento (v6)
let pairingState = {
  auth_key: '',
  timestamp: 0,
  ip: '',
  port: 1926
};

// Guardar configuración a archivo
function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(tvConfig, null, 2), 'utf8');
  } catch (err) {
    console.error('Error al guardar config.json:', err);
  }
}

// Helper para hash MD5
function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

// Helper para leer la dirección MAC desde la tabla ARP
function getMacFromArp(ip) {
  try {
    if (!fs.existsSync('/proc/net/arp')) return null;
    const arpContent = fs.readFileSync('/proc/net/arp', 'utf8');
    const lines = arpContent.split('\n');
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts[0] === ip) {
        const mac = parts[3];
        if (mac && mac !== '00:00:00:00:00:00' && mac.includes(':')) {
          return mac;
        }
      }
    }
  } catch (e) {
    console.error('Error al leer tabla ARP:', e);
  }
  return null;
}

// Helper para enviar un paquete de encendido Wake-on-LAN
async function sendWOL(macAddress) {
  const cleanMac = macAddress.replace(/:/g, '');
  if (cleanMac.length !== 12) {
    throw new Error('Formato de dirección MAC inválido');
  }
  
  const macBuffer = Buffer.from(cleanMac, 'hex');
  const packet = Buffer.alloc(102);
  
  // 6 bytes de 0xFF
  packet.fill(0xFF, 0, 6);
  
  // 16 repeticiones de la MAC
  for (let i = 0; i < 16; i++) {
    macBuffer.copy(packet, 6 + (i * 6));
  }

  const subnet = getLocalSubnet(); // ej: '192.168.0'
  const subnetBroadcast = `${subnet}.255`;
  const targets = ['255.255.255.255', subnetBroadcast];

  const sendPacket = (target) => {
    return new Promise((resolve) => {
      const socket = dgram.createSocket('udp4');
      socket.bind(() => {
        socket.setBroadcast(true);
        socket.send(packet, 0, packet.length, 9, target, (err) => {
          socket.close();
          resolve();
        });
      });
    });
  };

  // Enviamos el paquete a todos los objetivos, repetido 3 veces
  for (let attempt = 0; attempt < 3; attempt++) {
    await Promise.all(targets.map(target => sendPacket(target)));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

// Helper para realizar peticiones HTTP/HTTPS crudas
function rawRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const isHttps = options.url.startsWith('https:');
    const lib = isHttps ? https : http;
    
    const parsedUrl = new URL(options.url);
    const reqOptions = {
      method: options.method || 'GET',
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: options.headers || {},
      timeout: options.timeout || 3000
    };

    if (isHttps) {
      // Ignorar certificados auto-firmados de la TV
      reqOptions.rejectUnauthorized = false;
    }

    if (body) {
      reqOptions.headers['Content-Type'] = 'application/json';
      reqOptions.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = lib.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: data
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout de conexión con la TV'));
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

// Helper para parsear cabeceras WWW-Authenticate de Digest Auth
function parseDigestHeader(header) {
  const parts = header.replace(/^Digest\s+/, '').split(/,\s*(?=(?:[^"]|"[^"]*")*$)/);
  const auth = {};
  parts.forEach(part => {
    const [key, value] = part.split('=');
    if (key && value) {
      auth[key.trim()] = value.replace(/"/g, '').trim();
    }
  });
  return auth;
}

// Realizar petición con soporte para Digest Auth
async function authenticatedRequest(method, endpoint, body = null) {
  if (!tvConfig.ip) {
    throw new Error('IP de la TV no configurada');
  }

  const protocol = tvConfig.port === 1926 ? 'https' : 'http';
  const url = `${protocol}://${tvConfig.ip}:${tvConfig.port}${endpoint}`;
  const bodyString = body ? JSON.stringify(body) : null;

  // Si no requiere autenticación
  if (!tvConfig.authRequired || !tvConfig.password) {
    return await rawRequest({ method, url }, bodyString);
  }

  // Si requiere Digest Auth
  let res = await rawRequest({ method, url }, bodyString);
  if (res.statusCode !== 401 || !res.headers['www-authenticate']) {
    return res;
  }

  const authParams = parseDigestHeader(res.headers['www-authenticate']);
  const realm = authParams.realm || 'PhilipsTV';
  const nonce = authParams.nonce;
  const qop = authParams.qop;

  const parsedUrl = new URL(url);
  const uri = parsedUrl.pathname;

  const ha1 = md5(`${tvConfig.username}:${realm}:${tvConfig.password}`);
  const ha2 = md5(`${method}:${uri}`);
  const nc = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');

  let responseHash;
  if (qop === 'auth') {
    responseHash = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  } else {
    responseHash = md5(`${ha1}:${nonce}:${ha2}`);
  }

  let authHeader = `Digest username="${tvConfig.username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${responseHash}"`;
  if (qop) {
    authHeader += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  }

  return await rawRequest({
    method,
    url,
    headers: { 'Authorization': authHeader }
  }, bodyString);
}

// Escáner de puerto rápido
function checkPort(ip, port, timeout = 600) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let isOpened = false;

    socket.setTimeout(timeout);

    socket.on('connect', () => {
      isOpened = true;
      socket.destroy();
      resolve(true);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, ip);
  });
}

// Detectar IPs locales y subredes base
function getLocalSubnets() {
  const subnets = new Set(['192.168.0', '192.168.1']);
  const interfaces = os.networkInterfaces();
  for (const name in interfaces) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        const parts = net.address.split('.');
        if (parts.length === 4) {
          const subnet = parts.slice(0, 3).join('.');
          if (subnet !== '127.0.0' && !subnet.startsWith('172.17') && !subnet.startsWith('172.18')) {
            subnets.add(subnet);
          }
        }
      }
    }
  }
  return Array.from(subnets);
}

// Escanear una subred específica con límite de peticiones paralelas
async function scanSubnet(subnet, limit = 45) {
  const hosts = [];
  const ips = [];
  for (let i = 1; i <= 254; i++) {
    ips.push(`${subnet}.${i}`);
  }
  
  for (let i = 0; i < ips.length; i += limit) {
    const batch = ips.slice(i, i + limit);
    const promises = batch.map(ip => {
      return Promise.all([
        checkPort(ip, 1925).then(open => open ? { ip, port: 1925 } : null),
        checkPort(ip, 1926).then(open => open ? { ip, port: 1926 } : null)
      ]).then(results => results.filter(r => r !== null));
    });
    const batchResults = await Promise.all(promises);
    hosts.push(...batchResults.flat());
  }
  return hosts;
}

// Enpoints de la API del Backend

// 1. Obtener estado de configuración
app.get('/api/status', (req, res) => {
  res.json({
    ip: tvConfig.ip,
    apiVersion: tvConfig.apiVersion,
    port: tvConfig.port,
    configured: !!tvConfig.ip,
    hasCredentials: !!tvConfig.password,
    authRequired: tvConfig.authRequired,
    mac: tvConfig.mac,
    deviceId: tvConfig.deviceId
  });
});

// 2. Escaneo de red local
app.get('/api/scan', async (req, res) => {
  try {
    const subnets = getLocalSubnets();
    console.log(`Iniciando escaneo de red en subredes:`, subnets);
    
    const activeHosts = [];
    for (const subnet of subnets) {
      const found = await scanSubnet(subnet, 45);
      activeHosts.push(...found);
    }
    
    const tvs = [];
    for (const host of activeHosts) {
      try {
        const protocol = host.port === 1926 ? 'https' : 'http';
        const url = `${protocol}://${host.ip}:${host.port}/${host.port === 1926 ? '6' : '1'}/system`;
        
        const resSystem = await rawRequest({ method: 'GET', url, timeout: 1500 });
        if (resSystem.statusCode === 200 || resSystem.statusCode === 401) {
          let name = `Philips Smart TV (${host.ip})`;
          let apiVersion = host.port === 1926 ? 6 : 1;
          let pairingType = 'none';
          
          if (resSystem.statusCode === 200) {
            try {
              const sysInfo = JSON.parse(resSystem.data);
              name = sysInfo.name || name;
              if (sysInfo.api_version?.Major) {
                apiVersion = sysInfo.api_version.Major;
              }
              pairingType = sysInfo.featuring?.systemfeatures?.pairing_type || 'none';
            } catch (e) {}
          }
          
          const authRequired = (apiVersion === 6 && pairingType !== 'none') || resSystem.statusCode === 401;
          
          tvs.push({
            ip: host.ip,
            port: host.port,
            apiVersion: apiVersion,
            name: name,
            authRequired: authRequired
          });
        }
      } catch (err) {}
    }

    res.json({ tvs });
  } catch (err) {
    console.error('Error durante el escaneo de red:', err);
    res.status(500).json({ error: 'Fallo al escanear la red' });
  }
});

// 3. Conectarse manualmente a una IP
app.post('/api/connect', async (req, res) => {
  const { ip, port, apiVersion } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP requerida' });

  let targetPort = parseInt(port);
  let targetVersion = parseInt(apiVersion);
  
  if (!targetPort) {
    const is1926Open = await checkPort(ip, 1926);
    targetPort = is1926Open ? 1926 : 1925;
  }
  
  if (!targetVersion) {
    targetVersion = targetPort === 1926 ? 6 : 1;
  }
  
  const protocol = targetPort === 1926 ? 'https' : 'http';

  try {
    let checkRes;
    let finalVersion = targetVersion;
    
    try {
      const url = `${protocol}://${ip}:${targetPort}/${targetVersion}/system`;
      checkRes = await rawRequest({ method: 'GET', url, timeout: 2500 });
    } catch(err) {
      const altVersion = targetVersion === 6 ? 1 : 6;
      const urlAlt = `${protocol}://${ip}:${targetPort}/${altVersion}/system`;
      checkRes = await rawRequest({ method: 'GET', urlAlt, timeout: 2500 });
      finalVersion = altVersion;
    }

    if (checkRes.statusCode === 200 || checkRes.statusCode === 401) {
      let systemInfo = {};
      try {
        systemInfo = JSON.parse(checkRes.data);
      } catch(e) {}
      
      if (systemInfo.api_version?.Major) {
        finalVersion = systemInfo.api_version.Major;
      }
      
      const pairingType = systemInfo.featuring?.systemfeatures?.pairing_type || 'none';
      const authRequired = (finalVersion === 6 && pairingType !== 'none') || checkRes.statusCode === 401;

      // Intentamos capturar la dirección MAC de la TV
      const mac = getMacFromArp(ip);

      tvConfig.ip = ip;
      tvConfig.port = targetPort;
      tvConfig.apiVersion = finalVersion;
      tvConfig.authRequired = authRequired;
      if (mac) {
        tvConfig.mac = mac;
        console.log(`MAC detectada y guardada para ${ip}: ${mac}`);
      }

      if (!authRequired) {
        tvConfig.username = '';
        tvConfig.password = '';
        saveConfig();
        return res.json({
          success: true,
          paired: true,
          message: `Conectado con éxito a la TV (API v${finalVersion}, sin emparejamiento)`,
          system: systemInfo
        });
      }

      if (tvConfig.password) {
        try {
          const testRes = await authenticatedRequest('GET', `/${finalVersion}/system`);
          if (testRes.statusCode === 200) {
            saveConfig();
            return res.json({
              success: true,
              paired: true,
              message: 'Conectado usando credenciales guardadas',
              system: JSON.parse(testRes.data)
            });
          }
        } catch (e) {}
      }

      saveConfig();
      return res.json({
        success: true,
        paired: false,
        message: 'La TV requiere emparejamiento'
      });
    }
    
    res.status(400).json({ error: 'La TV no respondió de manera compatible' });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo conectar a la TV: ' + err.message });
  }
});

// 4. Iniciar emparejamiento (v6)
app.post('/api/pair/request', async (req, res) => {
  if (!tvConfig.ip || tvConfig.apiVersion !== 6) {
    return res.status(400).json({ error: 'La TV no está configurada en modo API v6' });
  }

  const url = `https://${tvConfig.ip}:${tvConfig.port}/6/pair/request`;
  const payload = {
    scope: ['read', 'write', 'control'],
    device: {
      device_name: 'Control Remoto Web',
      device_os: 'Linux',
      app_name: 'AntigravityRemote',
      app_id: 'com.antigravity.remote',
      type: 'native',
      id: tvConfig.deviceId
    }
  };

  try {
    const pairRes = await rawRequest({
      method: 'POST',
      url
    }, JSON.stringify(payload));

    if (pairRes.statusCode === 200) {
      const data = JSON.parse(pairRes.data);
      
      pairingState.auth_key = data.key;
      pairingState.timestamp = data.timestamp;
      pairingState.ip = tvConfig.ip;
      pairingState.port = tvConfig.port;

      res.json({
        success: true,
        message: 'Código de emparejamiento solicitado. Por favor ingresa el PIN mostrado en la pantalla de la TV.'
      });
    } else {
      res.status(pairRes.statusCode).json({
        error: 'Error al solicitar emparejamiento a la TV: ' + pairRes.data
      });
    }
  } catch (err) {
    res.status(500).json({ error: 'Fallo de red al solicitar emparejamiento: ' + err.message });
  }
});

// 5. Validar PIN y finalizar emparejamiento (v6)
app.post('/api/pair/grant', async (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'PIN requerido' });

  if (!pairingState.auth_key || pairingState.ip !== tvConfig.ip) {
    return res.status(400).json({ error: 'Flujo de emparejamiento no iniciado o expirado' });
  }

  const toSign = pairingState.timestamp.toString() + pin.toString();
  const secretKey = Buffer.from(pairingState.auth_key, 'base64');
  
  const signature = crypto.createHmac('sha1', secretKey)
    .update(toSign)
    .digest('base64');

  const payload = {
    auth: {
      auth_AppId: '1',
      pin: pin.toString(),
      auth_timestamp: pairingState.timestamp,
      auth_signature: signature
    }
  };

  const url = `https://${tvConfig.ip}:${tvConfig.port}/6/pair/grant`;

  try {
    const grantRes = await rawRequest({
      method: 'POST',
      url
    }, JSON.stringify(payload));

    if (grantRes.statusCode === 200) {
      const data = JSON.parse(grantRes.data);
      
      tvConfig.username = tvConfig.deviceId;
      tvConfig.password = data.password || pairingState.auth_key;
      saveConfig();

      pairingState = { auth_key: '', timestamp: 0, ip: '', port: 1926 };

      res.json({
        success: true,
        message: 'Emparejamiento completado con éxito y credenciales guardadas.'
      });
    } else {
      res.status(grantRes.statusCode).json({
        error: 'El PIN no es correcto o el emparejamiento fue rechazado por la TV.'
      });
    }
  } catch (err) {
    res.status(500).json({ error: 'Fallo al completar el emparejamiento: ' + err.message });
  }
});

// 6. Enviar comando de tecla
app.post('/api/command', async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'Tecla requerida' });

  // Si es el botón de apagado o encendido y no estamos conectados o falla la conexión,
  // intentamos enviar un paquete Wake-on-LAN si tenemos la MAC guardada
  if (key === 'Power' || key === 'Standby') {
    if (tvConfig.mac) {
      console.log(`Enviando paquete Wake-on-LAN a la MAC: ${tvConfig.mac}`);
      try {
        await sendWOL(tvConfig.mac);
      } catch (err) {
        console.error('Error al enviar Wake-on-LAN:', err);
      }
    }
  }

  const endpoint = `/${tvConfig.apiVersion}/input/key`;
  const payload = { key: key };

  try {
    const resCmd = await authenticatedRequest('POST', endpoint, payload);
    if (resCmd.statusCode === 200 || resCmd.data.includes('OK') || resCmd.statusCode === 201) {
      res.json({ success: true, message: `Comando ${key} enviado con éxito` });
    } else {
      res.status(resCmd.statusCode).json({
        error: `Error al enviar comando. Código de estado de la TV: ${resCmd.statusCode}`,
        details: resCmd.data
      });
    }
  } catch (err) {
    // Si falló por red y es Power/Standby, ya enviamos el WOL, así que respondemos con éxito condicional
    if (key === 'Power' || key === 'Standby') {
      return res.json({ success: true, message: 'Se envió un paquete de encendido (Wake-on-LAN) a la TV' });
    }
    res.status(500).json({ error: 'Fallo al comunicarse con la TV: ' + err.message });
  }
});

// 6.5. Obtener lista de canales (con descubrimiento dinámico y fallbacks)
app.get('/api/channels', async (req, res) => {
  if (!tvConfig.ip) {
    return res.status(400).json({ error: 'La TV no está configurada' });
  }

  let lastError = null;

  // Paso 1: Intentar descubrir las listas de canales dinámicamente de la TV
  try {
    const listEndpoint = `/${tvConfig.apiVersion}/channeldb/tv/channelLists`;
    console.log(`Paso 1: Descubriendo listas de canales en: ${listEndpoint}`);
    const listRes = await authenticatedRequest('GET', listEndpoint);
    
    if (listRes.statusCode === 200) {
      const listData = JSON.parse(listRes.data);
      console.log('Listas de canales encontradas:', JSON.stringify(listData));
      
      let lists = [];
      if (Array.isArray(listData)) {
        lists = listData;
      } else if (listData.channelLists && Array.isArray(listData.channelLists)) {
        lists = listData.channelLists;
      } else if (listData.ChannelList && Array.isArray(listData.ChannelList)) {
        lists = listData.ChannelList;
      }
      
      const listIds = lists.map(l => l.id).filter(id => id);
      
      // Intentar obtener canales de cada lista descubierta
      for (const listId of listIds) {
        const endpointsToTry = [
          `/${tvConfig.apiVersion}/channeldb/tv/channelLists/${listId}/channels`,
          `/${tvConfig.apiVersion}/channeldb/tv/channelLists/${listId}`
        ];
        
        for (const endpoint of endpointsToTry) {
          try {
            console.log(`Intentando obtener canales de la lista descubierta '${listId}' en: ${endpoint}`);
            const testRes = await authenticatedRequest('GET', endpoint);
            if (testRes.statusCode === 200) {
              const data = JSON.parse(testRes.data);
              const channels = extractChannelsList(data);
              if (channels && channels.length > 0) {
                console.log(`¡Éxito! Obtenidos ${channels.length} canales de la lista '${listId}'`);
                return res.json({ success: true, channels, channelListId: listId });
              }
            }
          } catch (e) {
            console.warn(`Error al intentar ${endpoint}:`, e.message);
            lastError = e;
          }
        }
      }
    }
  } catch (err) {
    console.warn('Fallo al descubrir listas de canales, recurriendo a fallbacks estáticos:', err.message);
    lastError = err;
  }

  // Paso 2: Fallback estático con IDs comunes si el descubrimiento falló
  const commonListIds = ['allter', 'allsat', 'allcab', 'all'];
  for (const listId of commonListIds) {
    const endpoints = [
      `/${tvConfig.apiVersion}/channeldb/tv/channelLists/${listId}/channels`,
      `/${tvConfig.apiVersion}/channeldb/tv/channelLists/${listId}`
    ];
    
    for (const endpoint of endpoints) {
      try {
        console.log(`Paso 2: Intentando fallback estático '${listId}' en: ${endpoint}`);
        const testRes = await authenticatedRequest('GET', endpoint);
        if (testRes.statusCode === 200) {
          const data = JSON.parse(testRes.data);
          const channels = extractChannelsList(data);
          if (channels && channels.length > 0) {
            console.log(`¡Éxito! Obtenidos ${channels.length} canales (fallback estático) desde ${endpoint}`);
            return res.json({ success: true, channels, channelListId: listId });
          }
        }
      } catch (err) {
        console.warn(`Fallo en endpoint estático ${endpoint}:`, err.message);
        lastError = err;
      }
    }
  }

  // Paso 3: Fallback de último recurso (rutas legacy v1 / v5)
  const legacyEndpoints = [
    `/${tvConfig.apiVersion}/channels`,
    `/${tvConfig.apiVersion}/channeldb/tv`
  ];
  
  for (const endpoint of legacyEndpoints) {
    try {
      console.log(`Paso 3: Intentando ruta legacy en: ${endpoint}`);
      const testRes = await authenticatedRequest('GET', endpoint);
      if (testRes.statusCode === 200) {
        const data = JSON.parse(testRes.data);
        const channels = extractChannelsList(data);
        if (channels && channels.length > 0) {
          console.log(`¡Éxito! Obtenidos ${channels.length} canales (legacy) desde ${endpoint}`);
          return res.json({ success: true, channels });
        }
      }
    } catch (err) {
      console.warn(`Fallo en endpoint legacy ${endpoint}:`, err.message);
      lastError = err;
    }
  }

  res.status(500).json({ 
    error: 'No se pudo obtener la lista de canales de la TV tras intentar múltiples endpoints dinámicos, estáticos y legacy.',
    details: lastError ? lastError.message : 'Respuesta incompatible o sin canales sintonizados' 
  });
});

// Helper para extraer canales de la respuesta JSON
function extractChannelsList(rawData) {
  let rawChannels = null;
  if (Array.isArray(rawData)) {
    rawChannels = rawData;
  } else if (rawData.Channel && Array.isArray(rawData.Channel)) {
    rawChannels = rawData.Channel;
  } else if (rawData.ChannelList && rawData.ChannelList.List && Array.isArray(rawData.ChannelList.List)) {
    rawChannels = rawData.ChannelList.List;
  } else if (rawData.List && Array.isArray(rawData.List)) {
    rawChannels = rawData.List;
  } else if (typeof rawData === 'object') {
    // Si devuelve un diccionario indexado por ID
    const values = Object.values(rawData);
    if (values.length > 0 && typeof values[0] === 'object') {
      rawChannels = values;
    }
  }

  if (rawChannels && rawChannels.length > 0) {
    return rawChannels.map(ch => ({
      ccid: ch.ccid || ch.id || ch.channel_id || '',
      name: ch.name || `Canal ${ch.preset || ''}`,
      preset: ch.preset !== undefined ? String(ch.preset) : ''
    })).filter(ch => ch.ccid);
  }
  return null;
}

// 6.6. Obtener canal actual
app.get('/api/channels/current', async (req, res) => {
  if (!tvConfig.ip) {
    return res.status(400).json({ error: 'La TV no está configurada' });
  }

  const endpoints = [
    `/${tvConfig.apiVersion}/activities/tv`,
    `/${tvConfig.apiVersion}/channels/current`
  ];

  let lastError = null;

  for (const endpoint of endpoints) {
    try {
      console.log(`Consultando canal actual en: ${endpoint}`);
      const testRes = await authenticatedRequest('GET', endpoint);
      
      if (testRes.statusCode === 200) {
        let rawData;
        try {
          rawData = JSON.parse(testRes.data);
        } catch (e) {
          continue;
        }

        let channelInfo = null;
        if (rawData.channel) {
          channelInfo = rawData.channel;
        } else if (rawData.ccid !== undefined) {
          channelInfo = rawData;
        }

        if (channelInfo) {
          return res.json({
            success: true,
            channel: {
              ccid: channelInfo.ccid || '',
              name: channelInfo.name || '',
              preset: channelInfo.preset !== undefined ? String(channelInfo.preset) : ''
            },
            channelList: rawData.channelList || null
          });
        }
      }
    } catch (err) {
      console.warn(`Fallo al consultar canal actual en ${endpoint}:`, err.message);
      lastError = err;
    }
  }

  // Si no está sintonizado ningún canal (por ejemplo si está en Netflix o Standby),
  // devolvemos un éxito pero indicando que no hay canal activo
  res.json({ success: true, channel: null, message: 'Ningún canal sintonizado actualmente' });
});

// 6.7. Cambiar canal
app.post('/api/channels/select', async (req, res) => {
  const { ccid, preset, name, channelListId } = req.body;
  if (!ccid) {
    return res.status(400).json({ error: 'ccid es requerido' });
  }

  if (!tvConfig.ip) {
    return res.status(400).json({ error: 'La TV no está configurada' });
  }

  // Intentamos cambiar canal usando el endpoint de v6
  if (tvConfig.apiVersion === 6) {
    const endpoint = '/6/activities/tv';
    const payload = {
      channel: {
        ccid: parseInt(ccid) || ccid,
        preset: preset || undefined,
        name: name || undefined
      },
      channelList: {
        id: channelListId || 'all'
      }
    };

    try {
      console.log(`Intentando sintonizar canal v6 (ccid: ${ccid})`);
      const resCmd = await authenticatedRequest('POST', endpoint, payload);
      if (resCmd.statusCode >= 200 && resCmd.statusCode < 300) {
        return res.json({ success: true, message: `Canal ${name || ccid} seleccionado` });
      }
    } catch (err) {
      console.warn('Error al cambiar canal v6:', err.message);
    }
  }

  // Fallback para v1 o si v6 falló
  const endpointV1 = '/1/channels/current';
  const payloadV1 = {
    channel: {
      ccid: parseInt(ccid) || ccid
    }
  };

  try {
    console.log(`Intentando sintonizar canal fallback v1 (ccid: ${ccid})`);
    const resCmd = await authenticatedRequest('POST', endpointV1, payloadV1);
    if (resCmd.statusCode >= 200 && resCmd.statusCode < 300) {
      return res.json({ success: true, message: `Canal sintonizado con éxito (v1 fallback)` });
    }
  } catch (err) {
    console.error('Error al sintonizar canal en v1:', err.message);
  }

  // Si fallaron los métodos directos del API, intentamos emular pulsaciones de teclas numéricas!
  if (preset) {
    console.log(`Intentando sintonizar canal emulando dígitos para preset: ${preset}`);
    try {
      const digits = String(preset).split('');
      for (const digit of digits) {
        const key = `Digit${digit}`;
        await authenticatedRequest('POST', `/${tvConfig.apiVersion}/input/key`, { key });
        await new Promise(resolve => setTimeout(resolve, 250)); // Pequeño retardo entre dígitos
      }
      return res.json({ success: true, message: `Canal cambiado emulando dígitos para preset ${preset}` });
    } catch (err) {
      console.error('Error al emular dígitos de canal:', err.message);
    }
  }

  res.status(500).json({ error: 'No se pudo sintonizar el canal en la TV' });
});

// 6.8. Lanzar aplicaciones (YouTube, Netflix)
app.post('/api/apps/launch', async (req, res) => {
  const { appName } = req.body;
  if (!appName) return res.status(400).json({ error: 'Nombre de app requerido' });
  
  if (!tvConfig.ip) {
    return res.status(400).json({ error: 'La TV no está configurada' });
  }

  const apiVersion = tvConfig.apiVersion;
  const keyLower = appName.toLowerCase();
  
  // Objetos de aplicación estándar para /applications/launch
  const appFallbacks = {
    youtube: {
      id: 'com.google.android.youtube.tv',
      label: 'YouTube',
      intent: {
        component: {
          packageName: 'com.google.android.youtube.tv',
          className: 'com.google.android.apps.youtube.tv.activity.ShellActivity'
        }
      },
      type: 'android_app'
    },
    netflix: {
      id: 'com.netflix.ninja',
      label: 'Netflix',
      intent: {
        component: {
          packageName: 'com.netflix.ninja',
          className: 'com.netflix.ninja.MainActivity'
        }
      },
      type: 'android_app'
    }
  };

  // Objetos de actividad para /activities/launch
  const activityFallbacks = {
    youtube: {
      intent: {
        action: 'android.intent.action.VIEW',
        component: {
          packageName: 'com.google.android.youtube.tv',
          className: 'com.google.android.apps.youtube.tv.activity.ShellActivity'
        }
      }
    },
    netflix: {
      intent: {
        action: 'android.intent.action.VIEW',
        component: {
          packageName: 'com.netflix.ninja',
          className: 'com.netflix.ninja.MainActivity'
        }
      }
    }
  };

  let launched = false;
  let lastErrorDetail = null;

  // Método 1: Intentar buscar y lanzar de la lista de aplicaciones de la TV
  try {
    const appListEndpoint = `/${apiVersion}/applications`;
    console.log(`Obteniendo lista de aplicaciones desde: ${appListEndpoint}`);
    const appsRes = await authenticatedRequest('GET', appListEndpoint);
    
    if (appsRes.statusCode === 200) {
      const appsData = JSON.parse(appsRes.data);
      let apps = [];
      if (appsData.applications && Array.isArray(appsData.applications)) {
        apps = appsData.applications;
      } else if (Array.isArray(appsData)) {
        apps = appsData;
      }

      const targetApp = apps.find(app => {
        const label = (app.label || app.name || '').toLowerCase();
        const id = (app.id || '').toLowerCase();
        return label.includes(keyLower) || id.includes(keyLower);
      });

      if (targetApp) {
        const launchEndpoint = `/${apiVersion}/applications/launch`;
        console.log(`Lanzando app encontrada en la lista: ${targetApp.label || targetApp.name} via ${launchEndpoint}`);
        const launchRes = await authenticatedRequest('POST', launchEndpoint, targetApp);
        if (launchRes.statusCode >= 200 && launchRes.statusCode < 300) {
          launched = true;
          return res.json({ success: true, message: `Aplicación ${targetApp.label || targetApp.name} lanzada con éxito` });
        } else {
          lastErrorDetail = `El endpoint /applications/launch devolvió código ${launchRes.statusCode}`;
        }
      }
    } else {
      lastErrorDetail = `Fallo al listar aplicaciones (código ${appsRes.statusCode})`;
    }
  } catch (err) {
    console.warn(`Fallo al intentar Método 1 (lista de apps):`, err.message);
    lastErrorDetail = err;
  }

  // Método 2: Lanzamiento directo con fallback estático a /applications/launch
  if (!launched && appFallbacks[keyLower]) {
    try {
      const endpoint = `/${apiVersion}/applications/launch`;
      console.log(`Intentando Método 2: POST ${endpoint} para '${appName}'`);
      const launchRes = await authenticatedRequest('POST', endpoint, appFallbacks[keyLower]);
      if (launchRes.statusCode >= 200 && launchRes.statusCode < 300) {
        launched = true;
        return res.json({ success: true, message: `Aplicación ${appName} lanzada con fallback de aplicaciones` });
      } else {
        lastErrorDetail = `El endpoint /applications/launch (fallback) devolvió código ${launchRes.statusCode}`;
      }
    } catch (err) {
      console.warn(`Fallo al intentar Método 2 (applications/launch fallback):`, err.message);
      lastErrorDetail = err;
    }
  }

  // Método 3: Lanzamiento directo a /activities/launch (Android TV intent)
  if (!launched && activityFallbacks[keyLower]) {
    try {
      const endpoint = `/${apiVersion}/activities/launch`;
      console.log(`Intentando Método 3: POST ${endpoint} para '${appName}'`);
      const launchRes = await authenticatedRequest('POST', endpoint, activityFallbacks[keyLower]);
      if (launchRes.statusCode >= 200 && launchRes.statusCode < 300) {
        launched = true;
        return res.json({ success: true, message: `Aplicación ${appName} lanzada con intent de actividades` });
      } else {
        lastErrorDetail = `El endpoint /activities/launch devolvió código ${launchRes.statusCode}`;
      }
    } catch (err) {
      console.warn(`Fallo al intentar Método 3 (activities/launch):`, err.message);
      lastErrorDetail = err;
    }
  }

  // Si no se pudo lanzar, dar una respuesta amigable pero detallada
  if (!launched) {
    let friendlyError = `No se pudo abrir ${appName} en la TV.`;
    
    // Si es una TV no-Android (como Saphi OS en puerto 1925 sin login)
    if (!tvConfig.authRequired && tvConfig.port === 1925) {
      friendlyError = `Tu televisor (modelo Linux/Saphi OS) no soporta el lanzamiento remoto de aplicaciones por red. Por favor usa el botón físico de tu control remoto.`;
    } else if (lastErrorDetail && (lastErrorDetail.code === 'ECONNRESET' || String(lastErrorDetail).includes('socket hang up') || String(lastErrorDetail).includes('ECONNRESET'))) {
      friendlyError = `Conexión rechazada por la TV (socket hang up). Tu modelo de Smart TV podría no tener activada o no admitir la API de lanzamiento de aplicaciones.`;
    } else if (lastErrorDetail) {
      friendlyError += ` Detalles: ${lastErrorDetail.message || lastErrorDetail}`;
    }

    return res.status(502).json({ error: friendlyError });
  }
});

// 7. Enviar comandos de Ambilight
app.post('/api/ambilight/mode', async (req, res) => {
  const { current, styleName } = req.body;
  const endpoint = `/${tvConfig.apiVersion}/ambilight/mode`;
  
  let payload = {};
  if (current) {
    payload.current = current;
  } else if (styleName) {
    payload.styleName = styleName;
    payload.isExpert = false;
    payload.menuSetting = "None";
  }

  try {
    const resCmd = await authenticatedRequest('POST', endpoint, payload);
    if (resCmd.statusCode >= 200 && resCmd.statusCode < 300) {
      res.json({ success: true, message: 'Modo Ambilight actualizado' });
    } else {
      res.status(resCmd.statusCode).json({
        error: `La TV rechazó el cambio de Ambilight: ${resCmd.statusCode}`
      });
    }
  } catch (err) {
    res.status(500).json({ error: 'Fallo al cambiar modo Ambilight: ' + err.message });
  }
});

app.post('/api/ambilight/color', async (req, res) => {
  const { r, g, b } = req.body;
  const endpoint = `/${tvConfig.apiVersion}/ambilight/cached`;
  
  const payload = {
    layer1: {
      left: { '0': { r, g, b } },
      right: { '0': { r, g, b } },
      top: { '0': { r, g, b } },
      bottom: { '0': { r, g, b } }
    }
  };

  try {
    const resCmd = await authenticatedRequest('POST', endpoint, payload);
    if (resCmd.statusCode >= 200 && resCmd.statusCode < 300) {
      res.json({ success: true, message: 'Color Ambilight actualizado' });
    } else {
      res.status(resCmd.statusCode).json({
        error: `La TV rechazó el color de Ambilight: ${resCmd.statusCode}`
      });
    }
  } catch (err) {
    res.status(500).json({ error: 'Fallo al cambiar color Ambilight: ' + err.message });
  }
});

// Iniciar servidor local
app.listen(PORT, '0.0.0.0', () => {
  console.log(`=============================================================`);
  console.log(`Servidor del Control Remoto Philips TV iniciado en puerto ${PORT}`);
  console.log(`Para usarlo en tu celular, entra a: http://<IP_DE_TU_COMPUTADORA>:${PORT}`);
  console.log(`=============================================================`);
});
