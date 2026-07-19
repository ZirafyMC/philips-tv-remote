// --- Philips Smart TV Web Remote - Frontend Logic (Hybrid PC/APK Client-Side) ---

// Elementos del DOM
const elStatusBadge = document.getElementById('status-badge');
const elStatusText = elStatusBadge.querySelector('.status-text');

// Tabs
const navTabs = document.querySelectorAll('.nav-tab');
const tabPanels = document.querySelectorAll('.tab-panel');

// Configuración Manual
const formConfig = document.getElementById('form-config');
const inputIp = document.getElementById('input-ip');
const selectVersion = document.getElementById('select-version');
const inputPort = document.getElementById('input-port');

// Escáner
const btnScan = document.getElementById('btn-scan');
const scanLoading = document.getElementById('scan-loading');
const scanResultsContainer = document.getElementById('scan-results-container');
const scanResultsList = document.getElementById('scan-results-list');
const scanBtnText = document.getElementById('scan-btn-text');

// Emparejamiento (Mantenido por compatibilidad de UI, oculto por defecto)
const cardPairing = document.getElementById('card-pairing');
const btnRequestPairing = document.getElementById('btn-request-pairing');
const pairingStep1 = document.getElementById('pairing-step-1');
const pairingStep2 = document.getElementById('pairing-step-2');
const inputPin = document.getElementById('input-pin');
const btnSubmitPin = document.getElementById('btn-submit-pin');

// Teclado Numérico
const btnToggleNum = document.getElementById('btn-toggle-num');
const numericKeypad = document.getElementById('numeric-keypad');

// TV Keyboard Input
const tvKeyboardInput = document.getElementById('tv-keyboard-input');
const btnKeyboardSend = document.getElementById('btn-keyboard-send');
const btnKeyboardClear = document.getElementById('btn-keyboard-clear');

// Ambilight
const btnAmbVideo = document.getElementById('amb-video');
const btnAmbAudio = document.getElementById('amb-audio');
const btnAmbOff = document.getElementById('amb-off');
const colorPresets = document.querySelectorAll('.preset-color');
const colorPickerInput = document.getElementById('color-picker-input');
const btnApplyColor = document.getElementById('btn-apply-color');

// EPG Guía
const btnShowGuide = document.getElementById('btn-show-guide');
const guideDrawer = document.getElementById('guide-drawer');
const btnCloseGuide = document.getElementById('btn-close-guide');
const guideActiveChannelInfo = document.getElementById('guide-active-channel-info');
const guideLoading = document.getElementById('guide-loading');
const guideChannelsList = document.getElementById('guide-channels-list');

// Estado de la app
let appState = {
  ip: '',
  apiVersion: 6,
  port: 1925,
  configured: false,
  authRequired: false,
  hasCredentials: false
};
let activeChannel = null;
let cachedChannels = [];

// Detectar si la app corre servida desde el backend de la PC o de forma local/APK
function checkIsLocalServer() {
  if (window.Capacitor) {
    return false;
  }
  return window.location.port === '3000' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
}

// Mostrar mensajes en la consola debug de la interfaz
function showDebug(msg) {
  const el = document.getElementById('debug-log');
  if (el) {
    el.textContent = `Consola: ${msg}`;
    console.log(`[Remote Debug] ${msg}`);
  }
}

// Wrapper de fetch compatible con Capacitor (evita CORS y bloqueos de red en el móvil)
async function hybridFetch(url, options = {}) {
  const isCapacitor = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
  const method = options.method || 'GET';
  const cleanUrl = url.replace(/https?:\/\/.*?\//, '/'); // Simplificar URL para el log
  const timeout = options.timeout || 4500; // Por defecto 4.5 segundos para dar suficiente margen de red
  const skipDebug = options.skipDebug || false;

  if (!skipDebug) {
    showDebug(`Enviando ${method} a ${cleanUrl}`);
  }

  if (isCapacitor) {
    try {
      const capHttp = window.Capacitor.Plugins.CapacitorHttp;
      const headers = options.headers || {};
      
      let data = undefined;
      if (options.body) {
        if (typeof options.body === 'string') {
          data = JSON.parse(options.body);
        } else {
          data = options.body;
        }
      }
      
      const nativeOptions = {
        url: url.startsWith('/') ? `${window.location.origin}${url}` : url,
        method,
        headers,
        data,
        connectTimeout: timeout,
        readTimeout: timeout
      };
      
      const response = await capHttp.request(nativeOptions);
      if (!skipDebug) {
        showDebug(`Respuesta: ${response.status} de ${method} ${cleanUrl}`);
      }
      
      return {
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
        json: async () => response.data,
        text: async () => typeof response.data === 'string' ? response.data : JSON.stringify(response.data),
        headers: {
          get: (name) => response.headers[name] || response.headers[name.toLowerCase()] || null
        }
      };
    } catch(err) {
      if (!skipDebug) {
        showDebug(`Error NAT: ${err.message || err} en ${cleanUrl}`);
      }
      console.error('Error en CapacitorHttp nativo:', err);
      throw err;
    }
  } else {
    try {
      const res = await fetch(url, options);
      if (!skipDebug) {
        showDebug(`Respuesta: ${res.status} de ${method} ${cleanUrl}`);
      }
      return res;
    } catch(err) {
      if (!skipDebug) {
        showDebug(`Error WEB: ${err.message || err} en ${cleanUrl}`);
      }
      throw err;
    }
  }
}


// Inicialización
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  checkStatus();
  initRemoteButtons();
  initSettingsListeners();
  initAmbilightListeners();
  initGuideListeners();
  initKeyboardInputListeners();
});

// Función de vibración haptica (feedback táctil)
function triggerHaptic() {
  if (navigator.vibrate) {
    navigator.vibrate(50);
  }
}

// Inicialización de pestañas
function initTabs() {
  navTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      triggerHaptic();
      
      const targetPanelId = tab.getAttribute('data-target');
      
      navTabs.forEach(t => t.classList.remove('active'));
      tabPanels.forEach(p => p.classList.remove('active'));
      
      tab.classList.add('active');
      document.getElementById(targetPanelId).classList.add('active');
    });
  });
}

// Navegar programáticamente a una pestaña
function navigateToTab(tabId) {
  const tab = Array.from(navTabs).find(t => t.getAttribute('data-target') === tabId);
  if (tab) {
    tab.click();
  }
}

// Comprobar estado de configuración
async function checkStatus() {
  const isLocalServer = checkIsLocalServer();
  
  if (isLocalServer) {
    try {
      const res = await hybridFetch('/api/status');
      const status = await res.json();
      appState = status;
      if (status.configured) {
        inputIp.value = status.ip;
        selectVersion.value = status.apiVersion;
        inputPort.value = status.port;
        updateStatusUI();
        fetchCurrentChannel();
      } else {
        updateStatusUI();
        navigateToTab('tab-settings');
      }
      return;
    } catch (err) {
      console.warn('Fallo al conectar al backend local, usando localStorage como fallback:', err);
    }
  }
  
  // Modo APK / Standalone: usar localStorage
  const ip = localStorage.getItem('tv_ip');
  const port = localStorage.getItem('tv_port');
  const apiVersion = localStorage.getItem('tv_api_version');
  const configured = localStorage.getItem('tv_configured') === 'true';

  if (configured && ip) {
    appState = {
      ip,
      apiVersion: parseInt(apiVersion) || 6,
      port: parseInt(port) || 1925,
      configured: true,
      authRequired: false,
      hasCredentials: false
    };
    inputIp.value = appState.ip;
    selectVersion.value = appState.apiVersion;
    inputPort.value = appState.port;
    
    updateStatusUI();
    fetchCurrentChannel();
  } else {
    appState.configured = false;
    updateStatusUI();
    navigateToTab('tab-settings');
  }
}

// Consultar canal actual directamente desde la TV o a través del backend
async function fetchCurrentChannel() {
  if (!appState.configured) return;
  const isLocalServer = checkIsLocalServer();

  if (isLocalServer) {
    try {
      const res = await hybridFetch('/api/channels/current');
      if (res.status === 200) {
        const rawData = await res.json();
        if (rawData.channel) {
          activeChannel = rawData.channel;
          updateStatusUI();
          return;
        }
      }
    } catch (e) {
      console.warn('Fallo al obtener canal actual mediante el backend:', e);
    }
  }

  // Llamada directa (Modo APK o fallback)
  const apiVersion = appState.apiVersion;
  const ip = appState.ip;
  const port = appState.port;
  const protocol = port === 1926 ? 'https' : 'http';
  const endpoints = [
    `${protocol}://${ip}:${port}/${apiVersion}/activities/tv`,
    `${protocol}://${ip}:${port}/${apiVersion}/channels/current`
  ];
  
  for (const url of endpoints) {
    try {
      const res = await hybridFetch(url, { timeout: 2500 });
      
      if (res.status === 200) {
        const rawData = await res.json();
        let channelInfo = null;
        if (rawData.channel) {
          channelInfo = rawData.channel;
        } else if (rawData.ccid !== undefined) {
          channelInfo = rawData;
        }
        
        if (channelInfo) {
          activeChannel = {
            ccid: channelInfo.ccid || '',
            name: channelInfo.name || '',
            preset: channelInfo.preset !== undefined ? String(channelInfo.preset) : ''
          };
          updateStatusUI();
          return;
        }
      }
    } catch (e) {
      console.warn(`Error al consultar canal actual en ${url}:`, e);
    }
  }
  
  activeChannel = null;
  updateStatusUI();
}

// Actualizar la barra de estado y la interfaz según la configuración
function updateStatusUI() {
  if (!appState.configured) {
    updateStatusIndicator('disconnected', 'Sin configurar');
    cardPairing.classList.add('hidden');
    return;
  }

  const channelText = activeChannel ? ` • ${activeChannel.name}` : '';
  updateStatusIndicator('connected', `Conectado (v${appState.apiVersion})${channelText}`);
  cardPairing.classList.add('hidden');
}

function updateStatusIndicator(stateClass, text) {
  elStatusBadge.className = `status-badge ${stateClass}`;
  elStatusText.textContent = text;
}

// Inicializar botones del control remoto
function initRemoteButtons() {
  document.querySelectorAll('[data-key]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      triggerHaptic();
      
      if (btn.id === 'btn-toggle-num') {
        toggleNumericKeypad();
        return;
      }
      
      const key = btn.getAttribute('data-key');
      
      btn.classList.add('pressed');
      setTimeout(() => btn.classList.remove('pressed'), 200);

      if (!appState.configured) {
        alert('Configura la IP de la TV en la pestaña de Ajustes primero.');
        return;
      }

      const isLocalServer = checkIsLocalServer();

      if (isLocalServer) {
        try {
          await hybridFetch('/api/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key })
          });
        } catch (err) {
          console.error('Error al enviar comando mediante backend:', err);
        }
      } else {
        // Llamada directa
        try {
          const protocol = appState.port === 1926 ? 'https' : 'http';
          const url = `${protocol}://${appState.ip}:${appState.port}/${appState.apiVersion}/input/key`;
          await hybridFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key })
          });
        } catch (err) {
          console.error('Error de red al enviar comando a la TV:', err);
        }
      }
    });
  });
}

// Alternar el keypad numérico
function toggleNumericKeypad() {
  btnToggleNum.classList.toggle('active');
  numericKeypad.classList.toggle('hidden');
}

// Inicializar lógica de Configuración y Escaneo
function initSettingsListeners() {
  formConfig.addEventListener('submit', async (e) => {
    e.preventDefault();
    triggerHaptic();

    const ip = inputIp.value.trim();
    const apiVersion = parseInt(selectVersion.value);
    const port = parseInt(inputPort.value);

    await connectToTv(ip, port, apiVersion);
  });

  selectVersion.addEventListener('change', () => {
    if (selectVersion.value === '6') {
      inputPort.value = '1926';
    } else {
      inputPort.value = '1925';
    }
  });

  btnScan.addEventListener('click', async () => {
    triggerHaptic();
    btnScan.disabled = true;
    scanBtnText.textContent = "Buscando...";
    btnScan.querySelector('svg').classList.add('icon-spin');
    scanLoading.classList.remove('hidden');
    scanResultsContainer.classList.add('hidden');
    scanResultsList.innerHTML = '';

    const isLocalServer = checkIsLocalServer();

    if (isLocalServer) {
      try {
        const res = await hybridFetch('/api/scan');
        const data = await res.json();
        
        scanLoading.classList.add('hidden');
        btnScan.disabled = false;
        scanBtnText.textContent = "Buscar en mi red";
        btnScan.querySelector('svg').classList.remove('icon-spin');

        if (data.tvs && data.tvs.length > 0) {
          renderScanResults(data.tvs);
        } else {
          alert('No se encontraron televisores Philips encendidos en la red local.');
        }
        return;
      } catch (err) {
        console.warn('Fallo escaneo de backend, usando escaneo de cliente:', err);
      }
    }

    // Escaneo en modo APK / Client-side
    try {
      let subnets = [];
      const tvIp = inputIp.value.trim() || localStorage.getItem('tv_ip');
      if (tvIp) {
        const parts = tvIp.split('.');
        if (parts.length === 4) {
          subnets = [parts.slice(0, 3).join('.')];
        }
      }
      
      // Fallback a subredes comunes solo si no hay ninguna IP configurada/guardada
      if (subnets.length === 0) {
        subnets = ['192.168.0', '192.168.1'];
      }

      const foundTvs = [];
      const maxParallel = 30; // Mayor número de peticiones en paralelo para escaneo rápido

      for (const subnet of subnets) {
        for (let i = 1; i <= 254; i += maxParallel) {
          const promises = [];
          for (let j = 0; j < maxParallel && (i + j) <= 254; j++) {
            const targetIp = `${subnet}.${i+j}`;
            promises.push((async () => {
              const checkEndpoints = [
                { url: `http://${targetIp}:1925/6/system`, port: 1925, ver: 6 },
                { url: `http://${targetIp}:1925/1/system`, port: 1925, ver: 1 },
                { url: `https://${targetIp}:1926/6/system`, port: 1926, ver: 6 }
              ];
              
              const checkPromises = checkEndpoints.map(endpoint => (async () => {
                try {
                  const res = await hybridFetch(endpoint.url, { timeout: 1800, skipDebug: true });
                  if (res.status === 200 || res.status === 401) {
                    let name = `Philips TV (${targetIp})`;
                    try {
                      const info = await res.json();
                      name = info.name || name;
                    } catch(e) {}
                    showDebug(`¡TV Encontrada en ${targetIp}!`);
                    return { ip: targetIp, port: endpoint.port, apiVersion: endpoint.ver, name };
                  }
                } catch(e) {}
                return null;
              })());
              
              const results = await Promise.all(checkPromises);
              return results.find(r => r !== null) || null;
            })());
          }
          const results = await Promise.all(promises);
          results.forEach(r => {
            if (r) foundTvs.push(r);
          });
        }
      }

      scanLoading.classList.add('hidden');
      btnScan.disabled = false;
      scanBtnText.textContent = "Buscar en mi red";
      btnScan.querySelector('svg').classList.remove('icon-spin');

      if (foundTvs.length > 0) {
        renderScanResults(foundTvs);
      } else {
        alert('No se encontraron televisores Philips encendidos en la red local.');
      }
    } catch (err) {
      console.error(err);
      alert('Ocurrió un error al buscar en la red: ' + err.message);
      scanLoading.classList.add('hidden');
      btnScan.disabled = false;
      scanBtnText.textContent = "Buscar en mi red";
      btnScan.querySelector('svg').classList.remove('icon-spin');
    }
  });

  btnRequestPairing.addEventListener('click', () => {
    alert('Emparejamiento no requerido para esta configuración.');
  });
  btnSubmitPin.addEventListener('click', () => {
    alert('Emparejamiento no requerido.');
  });
}

function renderScanResults(tvs) {
  scanResultsList.innerHTML = '';
  tvs.forEach(tv => {
    const li = document.createElement('li');
    li.className = 'device-item';
    li.innerHTML = `
      <div class="device-info">
        <span class="device-name">${tv.name}</span>
        <span class="device-ip">${tv.ip}:${tv.port}</span>
      </div>
      <span class="device-badge ${tv.apiVersion === 1 ? 'v1' : ''}">API v${tv.apiVersion}</span>
    `;
    
    li.addEventListener('click', async () => {
      triggerHaptic();
      inputIp.value = tv.ip;
      selectVersion.value = tv.apiVersion;
      inputPort.value = tv.port;
      await connectToTv(tv.ip, tv.port, tv.apiVersion);
    });

    scanResultsList.appendChild(li);
  });
  scanResultsContainer.classList.remove('hidden');
}

// Probar conexión y guardar configuración
async function connectToTv(ip, port, apiVersion) {
  const isLocalServer = checkIsLocalServer();

  if (isLocalServer) {
    try {
      const res = await hybridFetch('/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip, port, apiVersion })
      });
      const data = await res.json();
      if (data.success) {
        await checkStatus();
        alert(`¡Conectado con éxito a la TV!`);
        navigateToTab('tab-control');
      } else {
        alert('No se pudo conectar: ' + data.error);
      }
      return;
    } catch (err) {
      console.warn('Fallo al conectar con el backend local, intentando directo...', err);
    }
  }

  // Conexión Directa (APK)
  try {
    const protocol = port === 1926 ? 'https' : 'http';
    const url = `${protocol}://${ip}:${port}/${apiVersion}/system`;
    
    const res = await hybridFetch(url, { timeout: 4500 });
    
    if (res.status === 200 || res.status === 401) {
      let name = "Smart TV";
      try {
        const data = await res.json();
        name = data.name || name;
      } catch(e) {}

      localStorage.setItem('tv_ip', ip);
      localStorage.setItem('tv_port', port);
      localStorage.setItem('tv_api_version', apiVersion);
      localStorage.setItem('tv_configured', 'true');
      
      appState.ip = ip;
      appState.port = port;
      appState.apiVersion = apiVersion;
      appState.configured = true;
      
      alert(`¡Conectado con éxito a la TV: ${name}!`);
      updateStatusUI();
      fetchCurrentChannel();
      navigateToTab('tab-control');
    } else {
      alert(`Error: La TV respondió con código ${res.status}`);
    }
  } catch (err) {
    alert('No se pudo conectar a la TV. Verifica la IP e intenta de nuevo: ' + err.message);
  }
}

// Inicializar controles de Ambilight
function initAmbilightListeners() {
  btnAmbVideo.addEventListener('click', () => {
    setAmbilightMode({ styleName: 'FOLLOW_VIDEO' });
    setActiveAmbModeButton(btnAmbVideo);
  });

  btnAmbAudio.addEventListener('click', () => {
    setAmbilightMode({ styleName: 'FOLLOW_AUDIO' });
    setActiveAmbModeButton(btnAmbAudio);
  });

  btnAmbOff.addEventListener('click', () => {
    setAmbilightMode({ styleName: 'OFF' });
    setActiveAmbModeButton(btnAmbOff);
  });

  colorPresets.forEach(preset => {
    preset.addEventListener('click', async () => {
      triggerHaptic();
      const r = parseInt(preset.getAttribute('data-r'));
      const g = parseInt(preset.getAttribute('data-g'));
      const b = parseInt(preset.getAttribute('data-b'));
      
      await setAmbilightMode({ current: 'manual' });
      await setAmbilightColor(r, g, b);
      setActiveAmbModeButton(null);
    });
  });

  btnApplyColor.addEventListener('click', async () => {
    triggerHaptic();
    const hex = colorPickerInput.value;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);

    await setAmbilightMode({ current: 'manual' });
    await setAmbilightColor(r, g, b);
    setActiveAmbModeButton(null);
  });
}

function setActiveAmbModeButton(activeBtn) {
  btnAmbVideo.classList.remove('active');
  btnAmbAudio.classList.remove('active');
  btnAmbOff.classList.remove('active');
  if (activeBtn) activeBtn.classList.add('active');
}

async function setAmbilightMode(modePayload) {
  triggerHaptic();
  if (!appState.configured) return;

  const isLocalServer = checkIsLocalServer();

  if (isLocalServer) {
    try {
      const res = await hybridFetch('/api/ambilight/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(modePayload)
      });
      return await res.json();
    } catch (err) {
      console.error('Error al cambiar modo Ambilight mediante backend:', err);
    }
  } else {
    // Direct call
    try {
      const protocol = appState.port === 1926 ? 'https' : 'http';
      const url = `${protocol}://${appState.ip}:${appState.port}/${appState.apiVersion}/ambilight/mode`;
      const res = await hybridFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(modePayload)
      });
      return await res.json();
    } catch (err) {
      console.error('Error al cambiar modo Ambilight:', err);
    }
  }
}

async function setAmbilightColor(r, g, b) {
  if (!appState.configured) return;

  const isLocalServer = checkIsLocalServer();

  if (isLocalServer) {
    try {
      const res = await hybridFetch('/api/ambilight/color', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ r, g, b })
      });
      return await res.json();
    } catch (err) {
      console.error('Error al cambiar color Ambilight mediante backend:', err);
    }
  } else {
    // Direct call
    try {
      const protocol = appState.port === 1926 ? 'https' : 'http';
      const url = `${protocol}://${appState.ip}:${appState.port}/${appState.apiVersion}/ambilight/cached`;
      const payload = {
        layer1: {
          left: { '0': { r, g, b } },
          right: { '0': { r, g, b } },
          top: { '0': { r, g, b } },
          bottom: { '0': { r, g, b } }
        }
      };
      const res = await hybridFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      return await res.json();
    } catch (err) {
      console.error('Error al cambiar color Ambilight:', err);
    }
  }
}

// --- Lógica de la Guía de Canales (EPG) ---
function initGuideListeners() {
  if (!btnShowGuide) return;
  
  btnShowGuide.addEventListener('click', async () => {
    triggerHaptic();
    
    const confirmGuide = confirm("Advertencia: En algunos modelos de TV Philips (como Saphi OS), cargar la lista de canales satura el procesador de la TV y congela su control por red. ¿Deseas abrir la guía?");
    if (!confirmGuide) return;

    guideDrawer.classList.remove('hidden');
    await openChannelsGuide();
  });

  btnCloseGuide.addEventListener('click', () => {
    triggerHaptic();
    guideDrawer.classList.add('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!guideDrawer.classList.contains('hidden') && 
        !guideDrawer.contains(e.target) && 
        e.target !== btnShowGuide && 
        !btnShowGuide.contains(e.target)) {
      guideDrawer.classList.add('hidden');
    }
  });
}

async function openChannelsGuide() {
  if (!appState.configured) {
    guideActiveChannelInfo.textContent = "La TV no está configurada";
    guideLoading.classList.add('hidden');
    return;
  }

  guideLoading.classList.remove('hidden');
  guideChannelsList.classList.add('hidden');
  guideActiveChannelInfo.textContent = "Obteniendo estado...";

  try {
    await fetchCurrentChannel();
    
    if (activeChannel) {
      guideActiveChannelInfo.innerHTML = `Sintonizado en: <strong>${activeChannel.preset} - ${activeChannel.name}</strong>`;
    } else {
      guideActiveChannelInfo.textContent = "Canal actual: Ninguno sintonizado";
    }

    if (cachedChannels.length === 0) {
      const isLocalServer = checkIsLocalServer();

      if (isLocalServer) {
        try {
          const res = await hybridFetch('/api/channels');
          if (res.status === 200) {
            const data = await res.json();
            if (data.channels && data.channels.length > 0) {
              cachedChannels = data.channels.map(ch => ({
                ccid: ch.ccid || '',
                name: ch.name || '',
                preset: ch.preset !== undefined ? String(ch.preset) : ''
              }));
              renderChannelsGuide();
              return;
            }
          }
        } catch (e) {
          console.warn('Fallo al obtener canales desde backend local, intentando directo...', e);
        }
      }

      // Obtener directamente de la TV (Modo APK o fallback)
      const apiVersion = appState.apiVersion;
      const ip = appState.ip;
      const port = appState.port;
      const protocol = port === 1926 ? 'https' : 'http';
      
      let fetched = false;
      let lastErr = null;
      let channelsList = [];

      // Intentar descubrir listas de canales
      try {
        const listUrl = `${protocol}://${ip}:${port}/${apiVersion}/channeldb/tv/channelLists`;
        const listRes = await hybridFetch(listUrl, { timeout: 4500 });
        if (listRes.status === 200) {
          const listData = await listRes.json();
          let lists = [];
          if (Array.isArray(listData)) {
            lists = listData;
          } else if (listData.channelLists && Array.isArray(listData.channelLists)) {
            lists = listData.channelLists;
          } else if (listData.ChannelList && Array.isArray(listData.ChannelList)) {
            lists = listData.ChannelList;
          }
          
          const listIds = lists.map(l => l.id).filter(id => id);
          for (const listId of listIds) {
            const endpoints = [
              `${protocol}://${ip}:${port}/${apiVersion}/channeldb/tv/channelLists/${listId}/channels`,
              `${protocol}://${ip}:${port}/${apiVersion}/channeldb/tv/channelLists/${listId}`
            ];
            for (const url of endpoints) {
              try {
                const res = await hybridFetch(url, { timeout: 4500 });
                if (res.status === 200) {
                  const data = await res.json();
                  const rawList = data.channel || data;
                  if (Array.isArray(rawList) && rawList.length > 0) {
                    channelsList = rawList;
                    fetched = true;
                    break;
                  }
                }
              } catch(e) {
                lastErr = e;
              }
            }
            if (fetched) break;
          }
        }
      } catch(e) {
        lastErr = e;
      }

      // Fallbacks estáticos si no pudimos descubrir dinámicamente
      if (!fetched) {
        const staticListIds = ['allter', 'allsat', 'allcab', 'all'];
        for (const listId of staticListIds) {
          const endpoints = [
            `${protocol}://${ip}:${port}/${apiVersion}/channeldb/tv/channelLists/${listId}/channels`,
            `${protocol}://${ip}:${port}/${apiVersion}/channeldb/tv/channelLists/${listId}`
          ];
          for (const url of endpoints) {
            try {
              const res = await hybridFetch(url, { timeout: 4500 });
              if (res.status === 200) {
                const data = await res.json();
                const rawList = data.channel || data;
                if (Array.isArray(rawList) && rawList.length > 0) {
                  channelsList = rawList;
                  fetched = true;
                  break;
                }
              }
            } catch(e) {
              lastErr = e;
            }
          }
          if (fetched) break;
        }
      }

      // Último recurso: endpoint legacy de v1
      if (!fetched) {
        try {
          const url = `${protocol}://${ip}:${port}/1/channels`;
          const res = await hybridFetch(url, { timeout: 4500 });
          if (res.status === 200) {
            const data = await res.json();
            const rawList = data.channel || data;
            if (Array.isArray(rawList) && rawList.length > 0) {
              channelsList = rawList;
              fetched = true;
            }
          }
        } catch(e) {
          lastErr = e;
        }
      }

      if (!fetched) {
        throw new Error(lastErr ? lastErr.message : "No se pudo obtener la lista de canales de la TV");
      }

      cachedChannels = channelsList.map(ch => ({
        ccid: ch.ccid || '',
        name: ch.name || '',
        preset: ch.preset !== undefined ? String(ch.preset) : ''
      }));
    }

    renderChannelsGuide();
    
  } catch (err) {
    console.error('Error al abrir la guía:', err);
    guideLoading.classList.add('hidden');
    guideActiveChannelInfo.textContent = "Error al obtener canales";
    
    if (cachedChannels.length > 0) {
      renderChannelsGuide();
    } else {
      guideChannelsList.innerHTML = `<li class="guide-loading" style="padding: 20px 0; color: #ff5252;">${err.message || 'Fallo de red'}</li>`;
      guideChannelsList.classList.remove('hidden');
    }
  }
}

function renderChannelsGuide() {
  guideChannelsList.innerHTML = '';
  guideLoading.classList.add('hidden');
  
  if (cachedChannels.length === 0) {
    guideChannelsList.innerHTML = '<li class="guide-loading">No se encontraron canales.</li>';
    guideChannelsList.classList.remove('hidden');
    return;
  }

  cachedChannels.forEach(ch => {
    const isActive = activeChannel && activeChannel.ccid === ch.ccid;
    
    const li = document.createElement('li');
    li.className = `guide-channel-item ${isActive ? 'active' : ''}`;
    li.style.padding = '14px 18px';
    li.innerHTML = `
      <div class="guide-ch-preset" style="font-size: 1.1rem; width: 35px;">${ch.preset}</div>
      <div class="guide-ch-info">
        <div class="guide-ch-name-row" style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
          <span class="guide-ch-name" style="font-size: 0.95rem; font-weight: 600; color: white;">${ch.name}</span>
          ${isActive ? '<span class="guide-ch-active-label">Sintonizado</span>' : ''}
        </div>
      </div>
    `;

    li.addEventListener('click', async () => {
      triggerHaptic();
      guideDrawer.classList.add('hidden');
      
      const isLocalServer = checkIsLocalServer();

      if (isLocalServer) {
        try {
          const res = await hybridFetch('/api/channels/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ccid: ch.ccid,
              preset: ch.preset,
              name: ch.name
            })
          });
          const data = await res.json();
          if (data.success) {
            activeChannel = ch;
            updateStatusUI();
            return;
          }
        } catch (e) {
          console.warn('Fallo al sintonizar mediante backend, intentando directo...', e);
        }
      }

      // Cambio directo (Modo APK o fallback)
      try {
        const apiVersion = appState.apiVersion;
        const ip = appState.ip;
        const port = appState.port;
        const protocol = port === 1926 ? 'https' : 'http';
        let success = false;

        if (apiVersion === 6) {
          try {
            const url = `${protocol}://${ip}:${port}/6/activities/tv`;
            const payload = {
              channel: {
                ccid: parseInt(ch.ccid) || ch.ccid,
                preset: ch.preset ? parseInt(ch.preset) : undefined,
                name: ch.name || undefined
              },
              channelList: { id: 'all' }
            };
            const res = await hybridFetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            if (res.status >= 200 && res.status < 300) {
              success = true;
            }
          } catch(e) {
            console.warn('Fallo sintonización directa v6:', e);
          }
        }

        if (!success) {
          const url = `${protocol}://${ip}:${port}/1/channels/current`;
          const payload = {
            channel: { ccid: parseInt(ch.ccid) || ch.ccid }
          };
          const res = await hybridFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          if (res.status >= 200 && res.status < 300) {
            success = true;
          }
        }

        if (success) {
          activeChannel = ch;
          updateStatusUI();
        } else {
          alert('No se pudo cambiar al canal.');
        }
      } catch (e) {
        console.error('Error al sintonizar canal directamente:', e);
        alert('Error de red al sintonizar canal');
      }
    });

    guideChannelsList.appendChild(li);
  });

  guideChannelsList.classList.remove('hidden');

  setTimeout(() => {
    const activeItem = guideChannelsList.querySelector('.guide-channel-item.active');
    if (activeItem) {
      activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, 100);
}

// --- Lógica del teclado de texto para la TV ---

// Mapa de coordenadas para el teclado en cuadrícula de YouTube
const YOUTUBE_KEYBOARD_MAP = {
  'A': [0, 0], 'B': [0, 1], 'C': [0, 2], 'D': [0, 3], 'E': [0, 4], 'F': [0, 5], 'G': [0, 6],
  'H': [1, 0], 'I': [1, 1], 'J': [1, 2], 'K': [1, 3], 'L': [1, 4], 'M': [1, 5], 'N': [1, 6],
  'Ñ': [2, 0], 'O': [2, 1], 'P': [2, 2], 'Q': [2, 3], 'R': [2, 4], 'S': [2, 5], 'T': [2, 6],
  'U': [3, 0], 'V': [3, 1], 'W': [3, 2], 'X': [3, 3], 'Y': [3, 4], 'Z': [3, 5]
};

// Estado de la posición virtual del cursor en la TV
let ghostState = { row: 0, col: 0, inSpecialRow: false, lastCol: 0 };

function initKeyboardInputListeners() {
  if (!btnKeyboardSend || !tvKeyboardInput || !btnKeyboardClear) return;
  
  const chkGhostMode = document.getElementById('chk-ghost-mode');
  const btnCalibrateGhost = document.getElementById('btn-calibrate-ghost');

  if (chkGhostMode && btnCalibrateGhost) {
    chkGhostMode.addEventListener('change', () => {
      if (chkGhostMode.checked) {
        btnCalibrateGhost.style.display = 'inline-block';
        showDebug("Modo Fantasma activado. Calibra el cursor en la 'A' en YouTube.");
      } else {
        btnCalibrateGhost.style.display = 'none';
      }
    });

    btnCalibrateGhost.addEventListener('click', () => {
      triggerHaptic();
      ghostState = { row: 0, col: 0, inSpecialRow: false, lastCol: 0 };
      alert("Calibración completada. Asegúrate de que el cursor amarillo en la pantalla de la TV esté exactamente sobre la letra 'A' en el buscador de YouTube.");
      showDebug("Cursor fantasma calibrado en 'A' (0,0)");
    });
  }

  btnKeyboardSend.addEventListener('click', async () => {
    triggerHaptic();
    const text = tvKeyboardInput.value.trim();
    if (!text) return;
    
    btnKeyboardSend.disabled = true;
    tvKeyboardInput.disabled = true;
    btnKeyboardSend.textContent = "Enviando...";

    const useGhost = chkGhostMode && chkGhostMode.checked;
    
    if (useGhost) {
      await sendTextGhost(text);
    } else {
      await sendTextToTv(text);
    }
    
    tvKeyboardInput.value = '';
    btnKeyboardSend.disabled = false;
    tvKeyboardInput.disabled = false;
    btnKeyboardSend.textContent = "Enviar";
  });
  
  // Enviar texto al presionar Enter en el móvil
  tvKeyboardInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      btnKeyboardSend.click();
    }
  });
  
  btnKeyboardClear.addEventListener('click', async () => {
    triggerHaptic();
    
    if (tvKeyboardInput.value.length > 0) {
      tvKeyboardInput.value = tvKeyboardInput.value.slice(0, -1);
    }
    
    // Enviar tecla de borrar (Back) a la TV
    try {
      const isLocalServer = checkIsLocalServer();
      const key = 'Back';
      if (isLocalServer) {
        await hybridFetch('/api/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key })
        });
      } else {
        const protocol = appState.port === 1926 ? 'https' : 'http';
        const url = `${protocol}://${appState.ip}:${appState.port}/${appState.apiVersion}/input/key`;
        await hybridFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key })
        });
      }
    } catch(err) {
      console.warn('Error al borrar carácter en la TV:', err);
    }
  });
}

// Enviar texto letra a letra a la TV con delay (Para menús nativos del sistema)
async function sendTextToTv(text) {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    let key = char;
    
    if (char === ' ') {
      key = 'Space';
    } else if (char === '.') {
      key = 'Dot';
    }
    
    if (/[a-zA-Z]/.test(char)) {
      key = char.toUpperCase();
    } else if (/[0-9]/.test(char)) {
      key = `Digit${char}`;
    }

    try {
      const isLocalServer = checkIsLocalServer();
      if (isLocalServer) {
        await hybridFetch('/api/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key })
        });
      } else {
        const protocol = appState.port === 1926 ? 'https' : 'http';
        const url = `${protocol}://${appState.ip}:${appState.port}/${appState.apiVersion}/input/key`;
        await hybridFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key })
        });
      }
    } catch(err) {
      console.warn('Fallo al enviar carácter a la TV:', err);
    }
    
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

// Teclado Fantasma (Navegación automática simulada para YouTube)
const GHOST_VOWELS = [
  [0, 0], // A
  [0, 4], // E
  [1, 1], // I
  [2, 1], // O
  [3, 0], // U
  [1, 6]  // N (Muestra popup de Ñ)
];

function isGhostVowel(row, col) {
  return GHOST_VOWELS.some(([r, c]) => r === row && c === col);
}

async function sendTextGhost(text) {
  const cleanText = text
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // Quitar acentos y caracteres especiales

  const commands = [];
  let current = { ...ghostState };

  // Helper para empujar comandos actualizando la posición simulada y detectando si cae en vocal
  function addCommand(key) {
    if (key === 'CursorUp') {
      if (current.inSpecialRow) {
        current.row = 3;
        current.col = current.lastCol;
        current.inSpecialRow = false;
      } else {
        current.row = Math.max(0, current.row - 1);
      }
    } else if (key === 'CursorDown') {
      if (current.row === 3) {
        current.row = 4;
        current.lastCol = current.col;
        current.col = 0;
        current.inSpecialRow = true;
      } else if (current.row < 3) {
        current.row = current.row + 1;
      }
    } else if (key === 'CursorLeft') {
      current.col = Math.max(0, current.col - 1);
    } else if (key === 'CursorRight') {
      if (current.inSpecialRow) {
        current.col = Math.min(2, current.col + 1); // Fila especial sólo tiene 3 botones (0, 1, 2)
      } else {
        current.col = Math.min(7, current.col + 1);
      }
    }

    const landedOnVowel = !current.inSpecialRow && isGhostVowel(current.row, current.col);
    commands.push({ key, isVowelLand: landedOnVowel });
  }

  for (let i = 0; i < cleanText.length; i++) {
    const char = cleanText[i];
    
    if (char === ' ') {
      // Espacio (Fila especial 4, Columna 0)
      if (current.inSpecialRow) {
        if (current.col > 0) {
          const backTo0 = current.col;
          for (let c = 0; c < backTo0; c++) {
            addCommand('CursorLeft');
          }
        }
      } else {
        const downTo3 = 3 - current.row;
        for (let r = 0; r < downTo3; r++) {
          addCommand('CursorDown');
        }
        addCommand('CursorDown'); // Entra a fila especial (Espacio)
      }
      addCommand('Confirm');
    } else {
      const coords = YOUTUBE_KEYBOARD_MAP[char];
      if (!coords) continue; // Saltar letras/caracteres no contemplados en la cuadrícula
      
      const [targetRow, targetCol] = coords;
      
      if (current.inSpecialRow) {
        addCommand('CursorUp'); // Vuelve a fila 3 (columna lastCol)
      }
      
      const rowDiff = targetRow - current.row;
      
      // REGLA DE ORO: Si subimos y estamos sobre una vocal o letra inestable (Columna 1, U en 3,0, o N en 1,6),
      // nos movemos primero a una columna segura (Col 2 o Col 5 para N), subimos, y luego vamos a la col destino.
      const isUnsafeVowelCol = current.col === 1;
      const isUnsafeU = current.row === 3 && current.col === 0;
      const isUnsafeN = current.row === 1 && current.col === 6;
      
      if (rowDiff < 0 && (isUnsafeVowelCol || isUnsafeU || isUnsafeN)) {
        const safeCol = isUnsafeN ? 5 : 2;
        const colDiffToSafe = safeCol - current.col;
        if (colDiffToSafe > 0) {
          for (let c = 0; c < colDiffToSafe; c++) addCommand('CursorRight');
        } else if (colDiffToSafe < 0) {
          for (let c = 0; c < Math.abs(colDiffToSafe); c++) addCommand('CursorLeft');
        }
        
        // Mover verticalmente hacia arriba
        for (let r = 0; r < Math.abs(rowDiff); r++) addCommand('CursorUp');
        
        // Mover horizontalmente desde columna segura a la columna final
        const colDiffToTarget = targetCol - current.col;
        if (colDiffToTarget > 0) {
          for (let c = 0; c < colDiffToTarget; c++) addCommand('CursorRight');
        } else if (colDiffToTarget < 0) {
          for (let c = 0; c < Math.abs(colDiffToTarget); c++) addCommand('CursorLeft');
        }
      } else {
        // Navegación convencional
        // 1. Mover verticalmente
        if (rowDiff > 0) {
          for (let r = 0; r < rowDiff; r++) addCommand('CursorDown');
        } else if (rowDiff < 0) {
          for (let r = 0; r < Math.abs(rowDiff); r++) addCommand('CursorUp');
        }
        
        // 2. Mover horizontalmente
        const colDiff = targetCol - current.col;
        if (colDiff > 0) {
          for (let c = 0; c < colDiff; c++) addCommand('CursorRight');
        } else if (colDiff < 0) {
          for (let c = 0; c < Math.abs(colDiff); c++) addCommand('CursorLeft');
        }
      }
      
      addCommand('Confirm');
    }
  }

  if (commands.length === 0) return;

  const isLocalServer = checkIsLocalServer();
  const protocol = appState.port === 1926 ? 'https' : 'http';
  const url = `${protocol}://${appState.ip}:${appState.port}/${appState.apiVersion}/input/key`;

  showDebug(`Fantasma: Iniciando envío de ${cleanText}...`);

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    showDebug(`Fantasma: [${i+1}/${commands.length}] enviando ${cmd.key}`);
    
    try {
      if (isLocalServer) {
        await hybridFetch('/api/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: cmd.key }),
          skipDebug: true
        });
      } else {
        await hybridFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: cmd.key }),
          skipDebug: true
        });
      }
    } catch (e) {
      console.warn(`Error en envío de comando fantasma:`, e);
    }
    
    // Retraso base
    let delay = 320;
    if (cmd.key === 'Confirm') {
      delay = 550; // Confirm (OK) necesita más tiempo en pantalla
    }
    
    // Si caímos en una vocal, agregamos una espera extra de 250ms para esperar que aparezca y desaparezca el popup de acentos
    if (cmd.isVowelLand) {
      delay += 250;
    }
    
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  ghostState = current; // Registrar la nueva posición virtual del cursor
  showDebug(`Fantasma: ¡Texto '${cleanText}' ingresado!`);
}
