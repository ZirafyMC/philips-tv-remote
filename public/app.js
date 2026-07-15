// --- Philips Smart TV Web Remote - Frontend Logic (100% Client-Side) ---

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

// Emparejamiento (Mantenido por compatibilidad de UI, oculto por defecto ya que authRequired=false)
const cardPairing = document.getElementById('card-pairing');
const btnRequestPairing = document.getElementById('btn-request-pairing');
const pairingStep1 = document.getElementById('pairing-step-1');
const pairingStep2 = document.getElementById('pairing-step-2');
const inputPin = document.getElementById('input-pin');
const btnSubmitPin = document.getElementById('btn-submit-pin');

// Teclado Numérico
const btnToggleNum = document.getElementById('btn-toggle-num');
const numericKeypad = document.getElementById('numeric-keypad');

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

// Inicialización
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  checkStatus();
  initRemoteButtons();
  initSettingsListeners();
  initAmbilightListeners();
  initGuideListeners();
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

// Comprobar estado de configuración local (localStorage)
function checkStatus() {
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

// Consultar canal actual directamente desde la TV
async function fetchCurrentChannel() {
  if (!appState.configured) return;
  const apiVersion = appState.apiVersion;
  const ip = appState.ip;
  const port = appState.port;
  
  const endpoints = [
    `http://${ip}:${port}/${apiVersion}/activities/tv`,
    `http://${ip}:${port}/${apiVersion}/channels/current`
  ];
  
  for (const url of endpoints) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1800);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      
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

// Reset del panel de emparejamiento (mantenido por UI)
function resetPairingUI() {
  pairingStep1.classList.remove('hidden');
  pairingStep2.classList.add('hidden');
  inputPin.value = '';
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

      try {
        const url = `http://${appState.ip}:${appState.port}/${appState.apiVersion}/input/key`;
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key })
        });
      } catch (err) {
        console.error('Error de red al enviar comando a la TV:', err);
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
  // Guardar configuración manual
  formConfig.addEventListener('submit', async (e) => {
    e.preventDefault();
    triggerHaptic();

    const ip = inputIp.value.trim();
    const apiVersion = parseInt(selectVersion.value);
    const port = parseInt(inputPort.value);

    await connectToTv(ip, port, apiVersion);
  });

  // Ajustar puerto automáticamente según versión de API seleccionada
  selectVersion.addEventListener('change', () => {
    if (selectVersion.value === '6') {
      inputPort.value = '1926';
    } else {
      inputPort.value = '1925';
    }
  });

  // Escaneo de red directamente desde el cliente
  btnScan.addEventListener('click', async () => {
    triggerHaptic();
    btnScan.disabled = true;
    scanBtnText.textContent = "Buscando...";
    btnScan.querySelector('svg').classList.add('icon-spin');
    scanLoading.classList.remove('hidden');
    scanResultsContainer.classList.add('hidden');
    scanResultsList.innerHTML = '';

    try {
      // Intentar escanear subredes más habituales
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
      const maxParallel = 15;

      for (const subnet of subnets) {
        for (let i = 1; i <= 254; i += maxParallel) {
          const promises = [];
          for (let j = 0; j < maxParallel && (i + j) <= 254; j++) {
            const targetIp = `${subnet}.${i+j}`;
            promises.push((async () => {
              // Intentar en puertos comunes 1925 y 1926
              for (const port of [1925, 1926]) {
                const protocol = port === 1926 ? 'https' : 'http';
                for (const ver of [6, 1]) {
                  try {
                    const url = `${protocol}://${targetIp}:${port}/${ver}/system`;
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 650);
                    const res = await fetch(url, { signal: controller.signal });
                    clearTimeout(timeoutId);
                    if (res.status === 200 || res.status === 401) {
                      let name = `Philips TV (${targetIp})`;
                      try {
                        const info = await res.json();
                        name = info.name || name;
                      } catch(e) {}
                      return { ip: targetIp, port, apiVersion: ver, name };
                    }
                  } catch(e) {}
                }
              }
              return null;
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
        foundTvs.forEach(tv => {
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
      } else {
        alert('No se encontraron televisores Philips encendidos en la red local. Verifica la IP e ingrésala manualmente.');
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

  // Funciones de emparejamiento (desactivadas en client-side puro, mantenidas para compatibilidad visual)
  btnRequestPairing.addEventListener('click', () => {
    alert('Emparejamiento no requerido para esta configuración.');
  });
  btnSubmitPin.addEventListener('click', () => {
    alert('Emparejamiento no requerido.');
  });
}

// Guardar IP y probar conexión
async function connectToTv(ip, port, apiVersion) {
  try {
    const protocol = port === 1926 ? 'https' : 'http';
    const url = `${protocol}://${ip}:${port}/${apiVersion}/system`;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    
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
  try {
    const url = `http://${appState.ip}:${appState.port}/${appState.apiVersion}/ambilight/mode`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(modePayload)
    });
    return await res.json();
  } catch (err) {
    console.error('Error al cambiar modo Ambilight:', err);
  }
}

async function setAmbilightColor(r, g, b) {
  if (!appState.configured) return;
  try {
    const url = `http://${appState.ip}:${appState.port}/${appState.apiVersion}/ambilight/cached`;
    const payload = {
      layer1: {
        left: { '0': { r, g, b } },
        right: { '0': { r, g, b } },
        top: { '0': { r, g, b } },
        bottom: { '0': { r, g, b } }
      }
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (err) {
    console.error('Error al cambiar color Ambilight:', err);
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
      const apiVersion = appState.apiVersion;
      const ip = appState.ip;
      const port = appState.port;
      
      const endpoints = [
        `http://${ip}:${port}/${apiVersion}/channeldb/tv/channelLists/all/channels`,
        `http://${ip}:${port}/${apiVersion}/channeldb/tv/channelLists/all`,
        `http://${ip}:${port}/1/channels`
      ];
      
      let fetched = false;
      let lastErr = null;

      for (const url of endpoints) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 3000);
          const res = await fetch(url, { signal: controller.signal });
          clearTimeout(timeoutId);
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
      
      try {
        const apiVersion = appState.apiVersion;
        const ip = appState.ip;
        const port = appState.port;
        let success = false;

        if (apiVersion === 6) {
          try {
            const url = `http://${ip}:${port}/6/activities/tv`;
            const payload = {
              channel: {
                ccid: parseInt(ch.ccid) || ch.ccid,
                preset: ch.preset ? parseInt(ch.preset) : undefined,
                name: ch.name || undefined
              },
              channelList: {
                id: 'all'
              }
            };
            const res = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            if (res.status >= 200 && res.status < 300) {
              success = true;
            }
          } catch(e) {
            console.warn('Fallo sintonización v6:', e);
          }
        }

        if (!success) {
          const url = `http://${ip}:${port}/1/channels/current`;
          const payload = {
            channel: {
              ccid: parseInt(ch.ccid) || ch.ccid
            }
          };
          const res = await fetch(url, {
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
        console.error('Error al sintonizar canal:', e);
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
