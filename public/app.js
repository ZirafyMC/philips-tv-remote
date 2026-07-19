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

  showDebug(`Enviando ${method} a ${cleanUrl}`);

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
      showDebug(`Respuesta: ${response.status} de ${method} ${cleanUrl}`);
      
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
      showDebug(`Error NAT: ${err.message || err} en ${cleanUrl}`);
      console.error('Error en CapacitorHttp nativo:', err);
      throw err;
    }
  } else {
    try {
      const res = await fetch(url, options);
      showDebug(`Respuesta: ${res.status} de ${method} ${cleanUrl}`);
      return res;

    } catch(err) {
      showDebug(`Error WEB: ${err.message || err} en ${cleanUrl}`);
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
      let subnets = ['192.168.0', '192.168.1', '192.168.8'];
      const tvIp = inputIp.value.trim() || localStorage.getItem('tv_ip');
      if (tvIp) {
        const parts = tvIp.split('.');
        if (parts.length === 4) {
          const currentSubnet = parts.slice(0, 3).join('.');
          if (!subnets.includes(currentSubnet)) {
            subnets.unshift(currentSubnet);
          }
        }
      }

      const foundTvs = [];
      const maxParallel = 12;

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
                  const res = await hybridFetch(endpoint.url, { timeout: 950 });
                  if (res.status === 200 || res.status === 401) {
                    let name = `Philips TV (${targetIp})`;
                    try {
                      const info = await res.json();
                      name = info.name || name;
                    } catch(e) {}
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
  btnShowGuide.addEventListener('click', async () => {
    triggerHaptic();
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
      
      const endpoints = [
        `${protocol}://${ip}:${port}/${apiVersion}/channeldb/tv/channelLists/all/channels`,
        `${protocol}://${ip}:${port}/${apiVersion}/channeldb/tv/channelLists/all`,
        `${protocol}://${ip}:${port}/1/channels`
      ];
      
      let fetched = false;
      let lastErr = null;

      for (const url of endpoints) {
        try {
          const res = await hybridFetch(url, { timeout: 4500 });
          if (res.status === 200) {
            const rawData = await res.json();
            let channelList = [];
            if (rawData.channel && Array.isArray(rawData.channel)) {
              channelList = rawData.channel;
            } else if (Array.isArray(rawData)) {
              channelList = rawData;
            }
            
            cachedChannels = channelList.map(ch => ({
              ccid: ch.ccid || '',
              name: ch.name || '',
              preset: ch.preset !== undefined ? String(ch.preset) : ''
            }));
            fetched = true;
            break;
          }
        } catch (e) {
          console.warn(`Error al obtener canales en ${url}:`, e);
          lastErr = e;
        }
      }

      if (!fetched) {
        throw new Error(lastErr ? lastErr.message : "No se pudo obtener la lista de canales de la TV");
      }
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
function initKeyboardInputListeners() {
  if (!btnKeyboardSend || !tvKeyboardInput || !btnKeyboardClear) return;
  
  btnKeyboardSend.addEventListener('click', async () => {
    triggerHaptic();
    const text = tvKeyboardInput.value.trim();
    if (!text) return;
    
    btnKeyboardSend.disabled = true;
    btnKeyboardSend.textContent = "Enviando...";
    
    await sendTextToTv(text);
    
    tvKeyboardInput.value = '';
    btnKeyboardSend.disabled = false;
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

// Enviar texto letra a letra a la TV con delay
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
    
    // Retraso de 150ms entre caracteres para dar tiempo a la TV a procesarlos sin perder letras
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}
