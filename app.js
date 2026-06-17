/* ============================================================
   MTO Servicios HVAC — Control de Asistencia
   app.js — Lógica principal (GPS, Geofencing, Cámara, Envío)
   v1.0 — Producción
   ============================================================ */

'use strict';

/* ──────────────────────────────────────────────────────────────
   ██████╗  ██████╗ ███╗   ██╗███████╗██╗ ██████╗
   ██╔════╝██╔═══██╗████╗  ██║██╔════╝██║██╔════╝
   ██║     ██║   ██║██╔██╗ ██║█████╗  ██║██║  ███╗
   ██║     ██║   ██║██║╚██╗██║██╔══╝  ██║██║   ██║
   ╚██████╗╚██████╔╝██║ ╚████║██║     ██║╚██████╔╝
    ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝     ╚═╝ ╚═════╝

   ⚙️  CONFIGURACIÓN — Editá aquí antes de desplegar
──────────────────────────────────────────────────────────────── */
const CONFIG = {
  // ── GOOGLE APPS SCRIPT ──────────────────────────────────────
  // Pegá la URL de tu Web App después de publicar el Codigo.gs
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbwXBd4Llb1snlaIA2akC3X_-QuBd2SLwhkk8zsEBonCud8OD1W0Mb2isAsOtT1Ulhaf4Q/exec',

  // ── UBICACIÓN DE LA OFICINA ──────────────────────────────────
  // Cambiar por las coordenadas reales de tu oficina
  // (lat, lng) → buscalas en Google Maps haciendo clic derecho
  OFFICE_LAT: -34.504586,  // Domingo de Acassuso 1291, La Lucila
  OFFICE_LNG: -58.492084,  // Domingo de Acassuso 1291, La Lucila
  ALLOWED_RADIUS_METERS: 200, // radio permitido en metros

  // ── EMPRESA ──────────────────────────────────────────────────
  COMPANY_NAME: 'MTO Servicios HVAC',

  // ── EMPLEADOS (agrupados por sector) ─────────────────────────
  EMPLOYEE_GROUPS: [
    {
      label: '🔧 Servicio Mantenimiento',
      members: [
        'GOMEZ LEANDRO AGUSTIN',
        'GUERRA MARTIN ALEJANDRO',
        'LUGO MARCELO FABIAN',
        'DE ANDREIS GASTON ARIEL',
        'ANDINO CAMPOS DIEGO MAXIMILIANO',
        'PARADA EZEQUIEL ORLANDO',
        'QUINTANA VICTOR ALEJANDRO',
      ],
    },
    {
      label: '🏢 Oficina Administrativa',
      members: [
        'NICOLAS TRAUTMANN',
        'GENOVEVA JURADO',
        'MATIAS MOSOVICH',
        'AYELEN VECCHIARELLI',
        'LUCAS ALVAREZ',
        'MAXIMILIANO SUAREZ',
      ],
    },
    {
      label: '🏗️ Obras',
      members: [
        'NAHUEL BARRIOS',
      ],
    },
  ],

  // ── HORARIO OFICIAL ──────────────────────────────────────────
  // Para alertas de llegada tarde (formato 24h)
  WORK_START_HOUR: 8,
  WORK_START_MINUTE: 0,
  LATE_TOLERANCE_MINUTES: 15, // margen de gracia

  // ── SELFIE ───────────────────────────────────────────────────
  SELFIE_WIDTH: 480,
  SELFIE_HEIGHT: 640,
  SELFIE_QUALITY: 0.75, // JPEG quality 0-1

  // ── GPS ──────────────────────────────────────────────────────
  GPS_TIMEOUT_MS: 20000,    // tiempo máximo para obtener GPS
  GPS_MAX_AGE_MS: 0,        // no usar caché GPS (siempre fresco)
  GPS_HIGH_ACCURACY: true,
  MAX_ACCURACY_METERS: 200, // rechazar si precisión > 200m

  // ── ANTI-FRAUDE ──────────────────────────────────────────────
  MIN_SELFIE_SIZE_KB: 5,     // selfie sospechosa si muy pequeña
  DOUBLE_PUNCH_WINDOW_MIN: 5, // bloquear doble fichada en X minutos
  DEVICE_BLOCK_MINUTES: 10,  // minutos que un dispositivo queda bloqueado para fichar a OTRA persona

  // ── HOME OFFICE / OBRA ───────────────────────────────────────
  HOME_OFFICE_REQUIRES_APPROVAL: false, // si true, muestra aviso
  OBRA_RADIUS_METERS: 500,              // radio más amplio para técnicos en obra

  // ── MAPA ─────────────────────────────────────────────────────
  MAP_ZOOM_DEFAULT: 16,
  MAP_TILE_URL: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  MAP_ATTRIBUTION: '© OpenStreetMap © CARTO',
};

/* ──────────────────────────────────────────────────────────────
   ESTADO GLOBAL DE LA APP
──────────────────────────────────────────────────────────────── */
const state = {
  currentScreen: 'screenWelcome',
  employee: null,
  mode: 'oficina',
  observation: '',
  address: '',

  // GPS
  gpsGranted: false,
  gpsCoords: null,       // { lat, lng, accuracy }
  gpsDistance: null,     // distancia a oficina en metros
  gpsAllowed: false,     // dentro de geofence?
  gpsError: null,

  // Selfie
  selfieDataURL: null,   // base64 JPEG
  selfieSkipped: false,

  // Fichada
  punchType: null,       // ENTRADA | SALIDA | INICIO_ALMUERZO | FIN_ALMUERZO
  punchTimestamp: null,

  // UI
  map: null,
  markerUser: null,
  markerOffice: null,
  circleRadius: null,
  videoStream: null,
  lastPunches: {},       // { employeeName: timestamp } anti double-punch
  devicePunches: {},     // { deviceFingerprint: {employee, timestamp} } anti buddy-punch

  // Logs
  logs: [],
};

/* ──────────────────────────────────────────────────────────────
   UTILIDADES
──────────────────────────────────────────────────────────────── */
const utils = {

  /** Calcula distancia entre dos coordenadas usando fórmula Haversine */
  haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 6371000; // radio tierra en metros
    const toRad = deg => deg * (Math.PI / 180);
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat/2)**2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  },

  /** Formatea distancia para mostrar al usuario */
  formatDistance(meters) {
    if (meters < 1000) return `${Math.round(meters)} m`;
    return `${(meters / 1000).toFixed(1)} km`;
  },

  /** Formatea fecha/hora */
  formatDateTime(date = new Date()) {
    return date.toLocaleString('es-AR', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    });
  },

  /** Formatea solo hora */
  formatTime(date = new Date()) {
    return date.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  },

  /** Obtiene iniciales del nombre */
  getInitials(name) {
    return name.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase();
  },

  /** Comprueba si es llegada tarde */
  isLate(date = new Date()) {
    const startMinutes = CONFIG.WORK_START_HOUR * 60 + CONFIG.WORK_START_MINUTE;
    const currentMinutes = date.getHours() * 60 + date.getMinutes();
    return currentMinutes > (startMinutes + CONFIG.LATE_TOLERANCE_MINUTES);
  },

  /** Log con timestamp */
  log(level, msg, data = null) {
    const entry = { ts: new Date().toISOString(), level, msg, data };
    state.logs.push(entry);
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`[MTO HVAC][${level.toUpperCase()}] ${msg}`, data || '');
  },

  /** Muestra/oculta elementos */
  show(id) { const el = document.getElementById(id); if(el) { el.style.display = ''; el.classList.remove('hidden'); } },
  hide(id) { const el = document.getElementById(id); if(el) { el.style.display = 'none'; el.classList.add('hidden'); } },
  setText(id, text) { const el = document.getElementById(id); if(el) el.textContent = text; },
  setHTML(id, html) { const el = document.getElementById(id); if(el) el.innerHTML = html; },

  /** Sleep */
  sleep(ms) { return new Promise(r => setTimeout(r, ms)); },

  /** Genera un fingerprint simple del dispositivo */
  getDeviceFingerprint() {
    const nav = navigator;
    const raw = [
      nav.userAgent,
      screen.width + 'x' + screen.height,
      screen.colorDepth,
      nav.language,
      nav.hardwareConcurrency || '',
      nav.maxTouchPoints || '',
      new Date().getTimezoneOffset(),
    ].join('|');
    // Hash simple (djb2)
    let hash = 5381;
    for (let i = 0; i < raw.length; i++) {
      hash = ((hash << 5) + hash) + raw.charCodeAt(i);
      hash = hash & hash; // 32-bit
    }
    return 'dev_' + Math.abs(hash).toString(36);
  },

  /** Detecta si GPS podría ser falso (anti-spoofing básico) */
  suspectFakeGPS(coords) {
    // Coordenadas exactas 0,0 o sin decimales = sospechoso
    if (coords.lat === 0 && coords.lng === 0) return true;
    // Precisión perfecta es sospechosa
    if (coords.accuracy === 0) return true;
    // Precisión mayor a umbral = no fiable
    if (coords.accuracy > CONFIG.MAX_ACCURACY_METERS) return true;
    return false;
  },
};

/* ──────────────────────────────────────────────────────────────
   TOAST (notificaciones)
──────────────────────────────────────────────────────────────── */
const toast = {
  show(msg, type = 'info', duration = 4000) {
    const icons = { success:'✅', error:'❌', info:'ℹ️', warning:'⚠️' };
    const container = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="toast-icon">${icons[type]||'ℹ️'}</span><span class="toast-msg">${msg}</span>`;
    container.appendChild(el);
    setTimeout(() => {
      el.style.animation = 'toastOut 0.3s ease forwards';
      setTimeout(() => el.remove(), 300);
    }, duration);
  },
  success(msg, d) { this.show(msg, 'success', d); },
  error(msg, d)   { this.show(msg, 'error', d); },
  info(msg, d)    { this.show(msg, 'info', d); },
  warning(msg, d) { this.show(msg, 'warning', d); },
};

/* ──────────────────────────────────────────────────────────────
   MAPA (Leaflet)
──────────────────────────────────────────────────────────────── */
const mapManager = {

  init() {
    if (state.map) return;
    try {
      state.map = L.map('map', {
        zoomControl: false,
        attributionControl: false,
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        touchZoom: false,
      }).setView([CONFIG.OFFICE_LAT, CONFIG.OFFICE_LNG], CONFIG.MAP_ZOOM_DEFAULT);

      L.tileLayer(CONFIG.MAP_TILE_URL, {
        attribution: CONFIG.MAP_ATTRIBUTION,
        maxZoom: 19,
      }).addTo(state.map);

      // Marcador de oficina
      const officeIcon = L.divIcon({
        html: `<div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#3b82f6,#6366f1);display:grid;place-items:center;border:3px solid rgba(255,255,255,0.3);box-shadow:0 0 20px rgba(59,130,246,0.5);font-size:14px;">🏢</div>`,
        className: '', iconAnchor: [16, 16],
      });
      state.markerOffice = L.marker([CONFIG.OFFICE_LAT, CONFIG.OFFICE_LNG], { icon: officeIcon })
        .addTo(state.map)
        .bindPopup('<b>Oficina MTO HVAC</b>');

      // Círculo de geofence
      state.circleRadius = L.circle([CONFIG.OFFICE_LAT, CONFIG.OFFICE_LNG], {
        radius: CONFIG.ALLOWED_RADIUS_METERS,
        color: 'rgba(59,130,246,0.6)',
        fillColor: 'rgba(59,130,246,0.08)',
        fillOpacity: 1,
        weight: 2,
      }).addTo(state.map);

    } catch (e) {
      utils.log('warn', 'Map init failed', e);
    }
  },

  updateUserMarker(lat, lng, allowed) {
    if (!state.map) return;
    const color = allowed ? '#10b981' : '#ef4444';
    const userIcon = L.divIcon({
      html: `<div style="width:20px;height:20px;border-radius:50%;background:${color};border:3px solid rgba(255,255,255,0.8);box-shadow:0 0 16px ${color}66;animation:dotPulse 1.5s infinite;"></div>`,
      className: '', iconAnchor: [10, 10],
    });
    if (state.markerUser) state.markerUser.setLatLng([lat, lng]).setIcon(userIcon);
    else state.markerUser = L.marker([lat, lng], { icon: userIcon }).addTo(state.map);
    state.circleRadius.setStyle({ color: color + 'aa', fillColor: color + '14' });
  },

  fitBounds(userLat, userLng) {
    if (!state.map) return;
    const bounds = L.latLngBounds(
      [Math.min(userLat, CONFIG.OFFICE_LAT) - 0.001, Math.min(userLng, CONFIG.OFFICE_LNG) - 0.001],
      [Math.max(userLat, CONFIG.OFFICE_LAT) + 0.001, Math.max(userLng, CONFIG.OFFICE_LNG) + 0.001]
    );
    state.map.fitBounds(bounds, { padding: [20, 20] });
  },
};

/* ──────────────────────────────────────────────────────────────
   GPS & GEOFENCING
──────────────────────────────────────────────────────────────── */
const gpsManager = {

  async request() {
    utils.log('info', 'Requesting GPS permission');

    // UI — permiso solicitando
    this._setStatus('dotPermission', 'labelPermission', 'checking', 'Solicitando permisos GPS...');

    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('GPS no disponible en este dispositivo.'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Tiempo de espera agotado. Verificá que el GPS esté activado.'));
      }, CONFIG.GPS_TIMEOUT_MS);

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          clearTimeout(timeout);
          const { latitude: lat, longitude: lng, accuracy } = pos.coords;
          utils.log('info', `GPS obtained: ${lat}, ${lng} (acc: ${accuracy}m)`);

          // Anti-spoofing
          if (utils.suspectFakeGPS({ lat, lng, accuracy })) {
            if (accuracy > CONFIG.MAX_ACCURACY_METERS) {
              reject(new Error(`Señal GPS poco precisa (${Math.round(accuracy)}m). Salí al exterior e intentá de nuevo.`));
              return;
            }
          }

          resolve({ lat, lng, accuracy });
        },
        (err) => {
          clearTimeout(timeout);
          let msg = 'Error al obtener ubicación.';
          switch(err.code) {
            case err.PERMISSION_DENIED:
              msg = 'Permiso de ubicación denegado. Habilitalo en Configuración > Privacidad > Ubicación.'; break;
            case err.POSITION_UNAVAILABLE:
              msg = 'Ubicación no disponible. Verificá que el GPS esté activado.'; break;
            case err.TIMEOUT:
              msg = 'Tiempo de espera agotado. Intentá en un lugar con mejor señal GPS.'; break;
          }
          reject(new Error(msg));
        },
        {
          enableHighAccuracy: CONFIG.GPS_HIGH_ACCURACY,
          timeout: CONFIG.GPS_TIMEOUT_MS,
          maximumAge: CONFIG.GPS_MAX_AGE_MS,
        }
      );
    });
  },

  validateGeofence(lat, lng) {
    const effectiveRadius = state.mode === 'obra'
      ? CONFIG.OBRA_RADIUS_METERS
      : CONFIG.ALLOWED_RADIUS_METERS;

    const distance = utils.haversineDistance(lat, lng, CONFIG.OFFICE_LAT, CONFIG.OFFICE_LNG);
    const allowed = distance <= effectiveRadius;

    utils.log('info', `Geofence check: ${Math.round(distance)}m (limit: ${effectiveRadius}m) → ${allowed ? 'ALLOWED' : 'DENIED'}`);

    return { allowed, distance, effectiveRadius };
  },

  _setStatus(dotId, labelId, state, label) {
    const dot = document.getElementById(dotId);
    const lbl = document.getElementById(labelId);
    if (!dot || !lbl) return;
    dot.className = `status-dot ${state}`;
    lbl.textContent = label;
    const row = dot.closest('.status-row');
    if (row) row.className = `status-row ${state === 'ok' ? 'ok' : state === 'error' ? 'error' : ''}`;
  },
};

/* ──────────────────────────────────────────────────────────────
   CÁMARA & SELFIE
──────────────────────────────────────────────────────────────── */
const cameraManager = {

  async start() {
    utils.log('info', 'Starting camera');
    utils.show('cameraWrap');
    utils.hide('selfiePreview');
    utils.show('cameraControls');
    utils.hide('postCaptureControls');
    utils.hide('cameraError');

    const constraints = {
      video: {
        facingMode: 'user',
        width: { ideal: CONFIG.SELFIE_WIDTH },
        height: { ideal: CONFIG.SELFIE_HEIGHT },
      },
      audio: false,
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      state.videoStream = stream;
      const video = document.getElementById('cameraVideo');
      video.srcObject = stream;
      await video.play();
      utils.log('info', 'Camera stream started');
    } catch(err) {
      utils.log('error', 'Camera error', err);
      let msg = 'No se pudo acceder a la cámara.';
      if (err.name === 'NotAllowedError') msg = 'Permiso de cámara denegado. Habilitalo en Configuración del dispositivo.';
      else if (err.name === 'NotFoundError') msg = 'No se encontró cámara frontal en este dispositivo.';
      else if (err.name === 'NotReadableError') msg = 'La cámara está siendo usada por otra aplicación.';

      utils.hide('cameraWrap');
      utils.show('cameraError');
      utils.setText('cameraErrorMsg', msg);
      toast.error(msg);
    }
  },

  capture() {
    const video = document.getElementById('cameraVideo');
    const canvas = document.getElementById('selfieCanvas');

    canvas.width  = CONFIG.SELFIE_WIDTH;
    canvas.height = CONFIG.SELFIE_HEIGHT;

    const ctx = canvas.getContext('2d');
    // Espejear horizontalmente (ya que el video está espejado en CSS)
    ctx.save();
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.restore();

    const dataURL = canvas.toDataURL('image/jpeg', CONFIG.SELFIE_QUALITY);

    // Validar tamaño mínimo
    const sizeKB = Math.round(dataURL.length * 0.75 / 1024);
    utils.log('info', `Selfie captured: ${sizeKB}KB`);

    if (sizeKB < CONFIG.MIN_SELFIE_SIZE_KB) {
      toast.warning('La foto parece estar en blanco. Intentá de nuevo.');
      return null;
    }

    return dataURL;
  },

  stop() {
    if (state.videoStream) {
      state.videoStream.getTracks().forEach(t => t.stop());
      state.videoStream = null;
      utils.log('info', 'Camera stopped');
    }
  },
};

/* ──────────────────────────────────────────────────────────────
   ANTI-FRAUDE — Double punch check
──────────────────────────────────────────────────────────────── */
const antiFraud = {
  checkDoublePunch(employee, type) {
    const key = `${employee}__${type}`;
    const lastPunch = state.lastPunches[key];
    if (!lastPunch) return false;
    const diffMin = (Date.now() - lastPunch) / 60000;
    return diffMin < CONFIG.DOUBLE_PUNCH_WINDOW_MIN;
  },

  recordPunch(employee, type) {
    state.lastPunches[`${employee}__${type}`] = Date.now();
    try {
      sessionStorage.setItem('mto_last_punches', JSON.stringify(state.lastPunches));
    } catch(e) { /* silencio */ }
  },

  /** Verifica si este dispositivo ya fichó a OTRA persona recientemente */
  checkDeviceBuddy(employee) {
    const fp = utils.getDeviceFingerprint();
    try {
      const stored = localStorage.getItem('mto_device_punches');
      const devicePunches = stored ? JSON.parse(stored) : {};
      const last = devicePunches[fp];
      if (!last) return null;
      const diffMin = (Date.now() - last.timestamp) / 60000;
      if (diffMin < CONFIG.DEVICE_BLOCK_MINUTES && last.employee !== employee) {
        return last.employee; // devuelve quién fichó antes desde este dispositivo
      }
    } catch(e) { /* silencio */ }
    return null;
  },

  recordDevicePunch(employee) {
    const fp = utils.getDeviceFingerprint();
    try {
      const stored = localStorage.getItem('mto_device_punches');
      const devicePunches = stored ? JSON.parse(stored) : {};
      // Limpiar entradas viejas (> DEVICE_BLOCK_MINUTES) para no acumular basura
      const now = Date.now();
      Object.keys(devicePunches).forEach(key => {
        if ((now - devicePunches[key].timestamp) / 60000 >= CONFIG.DEVICE_BLOCK_MINUTES) {
          delete devicePunches[key];
        }
      });
      devicePunches[fp] = { employee, timestamp: now };
      localStorage.setItem('mto_device_punches', JSON.stringify(devicePunches));
      state.devicePunches = devicePunches;
    } catch(e) { /* silencio */ }
  },

  loadFromSession() {
    try {
      const data = sessionStorage.getItem('mto_last_punches');
      if (data) state.lastPunches = JSON.parse(data);
    } catch(e) { /* silencio */ }
    try {
      const dev = localStorage.getItem('mto_device_punches');
      if (dev) state.devicePunches = JSON.parse(dev);
    } catch(e) { /* silencio */ }
  },
};

/* ──────────────────────────────────────────────────────────────
   API — Envío a Google Apps Script
──────────────────────────────────────────────────────────────── */
const api = {

  async sendPunch(payload) {
    utils.log('info', 'Sending punch to Apps Script', { employee: payload.employee, type: payload.punchType });

    const formData = new FormData();
    // Serializar payload
    Object.entries(payload).forEach(([k, v]) => {
      if (v !== null && v !== undefined) formData.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(CONFIG.APPS_SCRIPT_URL, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

      const result = await response.json();
      utils.log('info', 'Apps Script response', result);
      return result;

    } catch(err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') throw new Error('Tiempo de espera agotado al enviar datos. Revisá la conexión.');
      throw err;
    }
  },
};

/* ──────────────────────────────────────────────────────────────
   PASOS (steps indicator UI)
──────────────────────────────────────────────────────────────── */
const stepsUI = {
  update(activeStep) {
    // 1=datos, 2=gps, 3=fichar
    for (let i = 1; i <= 3; i++) {
      const step = document.getElementById(`step${i}`);
      const line = document.getElementById(`stepLine${i}`);
      if (!step) continue;

      const dot  = step.querySelector('.step-dot');
      if (i < activeStep) {
        step.className = 'step done';
        if (dot) dot.textContent = '✓';
        if (line) line.className = 'step-line done';
      } else if (i === activeStep) {
        step.className = 'step active';
        if (dot) dot.textContent = String(i);
      } else {
        step.className = 'step';
        if (dot) dot.textContent = String(i);
      }
    }
  }
};

/* ──────────────────────────────────────────────────────────────
   ██████╗  ██████╗ ██████╗
   ██╔══██╗██╔══██╗██╔══██╗
   ███████║██████╔╝██████╔╝
   ██╔══██║██╔═══╝ ██╔═══╝
   ██║  ██║██║     ██║
   ╚═╝  ╚═╝╚═╝     ╚═╝

   CONTROLADOR PRINCIPAL DE LA APP
──────────────────────────────────────────────────────────────── */
const app = {

  /* ── Inicialización ──────────────────────────────────────── */
  init() {
    utils.log('info', 'App initializing', { version: '1.0', company: CONFIG.COMPANY_NAME });

    // Cargar anti-fraude desde sesión
    antiFraud.loadFromSession();

    // Poblar select de empleados según modo inicial
    this._populateEmployees(state.mode);

    // Reloj en tiempo real
    this._startClock();

    // Iniciar en pantalla bienvenida
    this.showScreen('screenWelcome');
    stepsUI.update(1);

    utils.log('info', 'App ready');
  },

  _populateEmployees(mode) {
    const sel = document.getElementById('employeeSelect');
    // Limpiar opciones actuales (excepto la primera vacía)
    while (sel.options.length > 1) sel.remove(1);
    // Eliminar optgroups anteriores
    Array.from(sel.querySelectorAll('optgroup')).forEach(g => g.remove());

    // Determinar qué grupos mostrar según el modo
    const GROUPS_BY_MODE = {
      oficina:    ['🏢 Oficina Administrativa'],
      obra:       ['🔧 Servicio Mantenimiento', '🏗️ Obras'],
      homeoffice: CONFIG.EMPLOYEE_GROUPS.map(g => g.label), // todos
    };
    const allowedLabels = GROUPS_BY_MODE[mode] || GROUPS_BY_MODE.oficina;

    CONFIG.EMPLOYEE_GROUPS
      .filter(group => allowedLabels.includes(group.label))
      .forEach(group => {
        const optgroup = document.createElement('optgroup');
        optgroup.label = group.label;
        group.members.slice().sort().forEach(name => {
          const opt = document.createElement('option');
          opt.value = name;
          opt.textContent = name;
          optgroup.appendChild(opt);
        });
        sel.appendChild(optgroup);
      });
  },

  _startClock() {
    const update = () => {
      const now = new Date();
      utils.setText('headerTime', utils.formatTime(now));
      utils.setText('summaryTime', utils.formatTime(now));
    };
    update();
    setInterval(update, 1000);
  },

  /* ── Navegación entre pantallas ─────────────────────────── */
  showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const screen = document.getElementById(id);
    if (screen) screen.classList.add('active');
    state.currentScreen = id;
    // Scroll al tope
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },

  goBack(targetScreen) {
    // Detener cámara si volvemos desde ella
    if (state.currentScreen === 'screenCamera') cameraManager.stop();
    state.punchType = null;
    this.showScreen(targetScreen);
  },

  /* ── PASO 1 → 2: Ir a GPS ────────────────────────────────── */
  async goToGPS() {
    const sel = document.getElementById('employeeSelect');
    const employeeName = sel.value.trim();

    if (!employeeName) {
      toast.error('Por favor seleccioná tu nombre.');
      sel.focus();
      return;
    }

    state.employee    = employeeName;
    state.observation = document.getElementById('observationInput').value.trim();
    state.address     = document.getElementById('addressInput').value.trim();

    // Validar modo obra con dirección
    if (state.mode === 'obra' && !state.address) {
      toast.warning('Ingresá la dirección de la obra.');
      document.getElementById('addressInput').focus();
      return;
    }

    utils.log('info', `Employee selected: ${employeeName}, mode: ${state.mode}`);

    stepsUI.update(2);
    this.showScreen('screenGPS');

    // Inicializar mapa
    mapManager.init();

    // Iniciar GPS
    await this.startGPS();
  },

  /* ── GPS: Solicitar y validar ────────────────────────────── */
  async startGPS() {
    utils.hide('btnGPSOK');
    utils.hide('btnRetryGPS');
    utils.hide('geoError');

    // Resetear estados UI
    const statuses = [
      { dot:'dotPermission', lbl:'labelPermission', val:null },
      { dot:'dotCoords',     lbl:'labelCoords',     val:null },
      { dot:'dotDistance',   lbl:'labelDistance',   val:'valueDistance' },
      { dot:'dotValidation', lbl:'labelValidation', val:null },
    ];
    statuses.forEach(s => {
      const dot = document.getElementById(s.dot);
      const lbl = document.getElementById(s.lbl);
      if (dot) { dot.className = 'status-dot'; }
      if (lbl) { lbl.style.color = ''; }
    });

    // Overlay mapa
    document.getElementById('mapOverlay').style.display = 'flex';

    try {
      // 1. Solicitar permisos y obtener posición
      gpsManager._setStatus('dotPermission', 'labelPermission', 'checking', 'Solicitando permisos GPS...');

      const coords = await gpsManager.request();
      state.gpsCoords  = coords;
      state.gpsGranted = true;

      gpsManager._setStatus('dotPermission', 'labelPermission', 'ok', '✓ Permisos GPS habilitados');

      // 2. Mostrar coordenadas
      gpsManager._setStatus('dotCoords', 'labelCoords', 'checking', 'Obteniendo coordenadas...');
      await utils.sleep(400);

      utils.setText('coordLat', coords.lat.toFixed(6));
      utils.setText('coordLng', coords.lng.toFixed(6));
      utils.setText('coordAcc', `±${Math.round(coords.accuracy)}m`);
      gpsManager._setStatus('dotCoords', 'labelCoords', 'ok', `✓ Ubicación obtenida (±${Math.round(coords.accuracy)}m)`);

      // 3. Calcular distancia
      gpsManager._setStatus('dotDistance', 'labelDistance', 'checking', 'Calculando distancia a oficina...');
      await utils.sleep(300);

      const { allowed, distance, effectiveRadius } = gpsManager.validateGeofence(coords.lat, coords.lng);
      state.gpsDistance = distance;
      state.gpsAllowed  = allowed;

      utils.setText('valueDistance', utils.formatDistance(distance));
      gpsManager._setStatus('dotDistance', 'labelDistance',
        allowed ? 'ok' : 'error',
        `${utils.formatDistance(distance)} de la oficina (radio: ${effectiveRadius}m)`
      );

      // 4. Actualizar mapa
      mapManager.updateUserMarker(coords.lat, coords.lng, allowed);
      mapManager.fitBounds(coords.lat, coords.lng);
      document.getElementById('mapOverlay').style.display = 'none';

      // Badge en mapa
      const overlay = document.getElementById('mapOverlay');
      overlay.style.display = 'flex';
      overlay.innerHTML = `<span class="map-badge ${allowed ? 'allowed' : 'denied'}">${allowed ? '✓ En zona' : '✗ Fuera de zona'}</span>`;

      // 5. Validar geofence
      await utils.sleep(300);

      // Home Office: ignorar restricción de distancia
      if (state.mode === 'homeoffice') {
        state.gpsAllowed = true;
        gpsManager._setStatus('dotValidation', 'labelValidation', 'ok', '✓ Modo Home Office — ubicación no requerida');
        toast.success('Modo Home Office. Pasando a fichaje...');
        await utils.sleep(1200);
        app.goToPunch();

      } else if (allowed) {
        gpsManager._setStatus('dotValidation', 'labelValidation', 'ok',
          state.mode === 'obra' ? '✓ Zona de obra verificada' : '✓ Dentro de zona autorizada'
        );
        toast.success('Ubicación verificada. Pasando a fichaje...');
        await utils.sleep(1200);
        app.goToPunch();

      } else {
        gpsManager._setStatus('dotValidation', 'labelValidation', 'error', 'Fuera de zona autorizada para fichar');
        state.gpsError = `Estás a ${utils.formatDistance(distance)} de la oficina. Radio permitido: ${effectiveRadius}m.`;

        utils.show('geoError');
        utils.setText('geoErrorMsg', state.gpsError);

        document.getElementById('btnRetryGPS').style.display = '';
        toast.error(`Fuera de zona. Distancia: ${utils.formatDistance(distance)}`);

        utils.log('warn', 'Geofence denied', { distance, allowed, employee: state.employee });
      }

    } catch(err) {
      utils.log('error', 'GPS failed', err.message);
      state.gpsError = err.message;
      state.gpsGranted = false;
      state.gpsAllowed = false;

      gpsManager._setStatus('dotPermission', 'labelPermission', 'error', '✗ ' + err.message);
      document.getElementById('mapOverlay').style.display = 'none';
      document.getElementById('btnRetryGPS').style.display = '';

      toast.error(err.message, 6000);
    }
  },

  /* ── PASO 2 → 3: Ir a cámara ─────────────────────────────── */
  async goToCamera() {
    if (!state.gpsAllowed && state.mode !== 'homeoffice') {
      toast.error('Ubicación no autorizada. No podés fichar desde esta ubicación.');
      return;
    }

    stepsUI.update(3);
    this.showScreen('screenCamera');
    await cameraManager.start();
  },

  /* ── Capturar selfie ─────────────────────────────────────── */
  captureSelfie() {
    const dataURL = cameraManager.capture();
    if (!dataURL) return;

    state.selfieDataURL = dataURL;
    state.selfieSkipped = false;

    // Mostrar preview
    cameraManager.stop();
    const preview = document.getElementById('selfiePreview');
    preview.src = dataURL;
    preview.style.display = 'block';
    preview.classList.remove('hidden');

    utils.hide('cameraWrap');
    utils.hide('cameraControls');
    document.getElementById('postCaptureControls').classList.remove('hidden');
    document.getElementById('postCaptureControls').style.display = '';

    toast.success('¡Foto capturada! Verificá que tu rostro esté visible.');
    utils.log('info', 'Selfie captured successfully');
  },

  /* ── Repetir selfie ──────────────────────────────────────── */
  async retakeSelfie() {
    state.selfieDataURL = null;
    document.getElementById('selfiePreview').style.display = 'none';
    document.getElementById('selfiePreview').classList.add('hidden');
    utils.show('cameraWrap');
    utils.show('cameraControls');
    document.getElementById('postCaptureControls').style.display = 'none';
    document.getElementById('postCaptureControls').classList.add('hidden');
    await cameraManager.start();
  },

  /* ── Omitir selfie (fallback) ────────────────────────────── */
  skipSelfie() {
    state.selfieDataURL = null;
    state.selfieSkipped = true;
    toast.warning('Selfie omitida. Se registrará sin foto de verificación.');
    this.goToPunch();
  },

  /* ── PASO 2 → 3: Ir a tipo de fichada ───────────────────── */
  goToPunch() {
    cameraManager.stop();
    state.selfieDataURL = null;
    state.selfieSkipped = true;  // selfie eliminada del flujo
    stepsUI.update(3);

    // Actualizar UI pantalla 4
    utils.setText('punchEmployeeName', state.employee);
    utils.setText('summaryDistance', utils.formatDistance(state.gpsDistance || 0));

    const modeLabels = { oficina:'🏢 Oficina', homeoffice:'🏠 Home Office', obra:'🔧 En Obra' };
    utils.setText('summaryMode', modeLabels[state.mode] || state.mode);
    utils.setText('punchModeBadge', modeLabels[state.mode] || state.mode);

    // Miniatura selfie
    const thumb = document.getElementById('punchSelfieThumb');
    const alt   = document.getElementById('punchSelfieAlt');
    if (state.selfieDataURL) {
      thumb.src = state.selfieDataURL;
      thumb.style.display = 'block';
      thumb.classList.remove('hidden');
      if (alt) alt.style.display = 'none';
    } else {
      if (alt) {
        alt.textContent = utils.getInitials(state.employee);
        alt.style.display = 'grid';
      }
      thumb.style.display = 'none';
      thumb.classList.add('hidden');
    }

    // Badge GPS
    const badge = document.getElementById('punchGpsStatus');
    if (badge) {
      if (state.gpsAllowed) {
        badge.className = 'badge badge-green';
        badge.textContent = `📍 ${utils.formatDistance(state.gpsDistance || 0)}`;
      } else {
        badge.className = 'badge badge-yellow';
        badge.textContent = '🏠 Home Office';
      }
    }

    // Reset tipo fichada
    document.querySelectorAll('.punch-btn').forEach(b => b.classList.remove('selected'));
    document.getElementById('btnConfirmPunch').disabled = true;
    state.punchType = null;

    this.showScreen('screenPunch');
  },

  /* ── Seleccionar tipo de fichada ─────────────────────────── */
  selectPunchType(type) {
    state.punchType = type;
    document.querySelectorAll('.punch-btn').forEach(b => {
      b.classList.toggle('selected', b.dataset.type === type);
    });
    document.getElementById('btnConfirmPunch').disabled = false;
    utils.log('info', `Punch type selected: ${type}`);
  },

  /* ── Cambiar modo ────────────────────────────────────────── */
  setMode(mode) {
    state.mode = mode;
    document.querySelectorAll('.mode-chip').forEach(c => {
      c.classList.toggle('active', c.dataset.mode === mode);
    });
    // Mostrar campo dirección solo en modo obra
    const addrGroup = document.getElementById('addressGroup');
    if (addrGroup) addrGroup.classList.toggle('hidden', mode !== 'obra');
    // Repoblar empleados según el modo y resetear selección
    document.getElementById('employeeSelect').value = '';
    this._populateEmployees(mode);
    utils.log('info', `Mode changed: ${mode}`);
  },

  /* ── PASO 4 → 5 → 6: Enviar fichada ─────────────────────── */
  async submitPunch() {
    if (!state.punchType) {
      toast.warning('Seleccioná el tipo de fichada antes de continuar.');
      return;
    }

    // Anti-buddy-punch: verificar que este dispositivo no fichó a OTRA persona recientemente
    const buddyEmployee = antiFraud.checkDeviceBuddy(state.employee);
    if (buddyEmployee) {
      toast.error(`Este dispositivo ya registró una fichada de ${buddyEmployee} hace menos de ${CONFIG.DEVICE_BLOCK_MINUTES} minutos. Cada empleado debe usar su propio celular.`, 7000);
      return;
    }

    // Anti-doble fichada
    if (antiFraud.checkDoublePunch(state.employee, state.punchType)) {
      toast.error(`Ya registraste "${state.punchType}" hace menos de ${CONFIG.DOUBLE_PUNCH_WINDOW_MIN} minutos. Esperá antes de volver a fichar.`);
      return;
    }

    const now = new Date();
    state.punchTimestamp = now;

    // Pantalla de carga
    this.showScreen('screenLoading');
    utils.setText('loadingTitle', 'Registrando fichada...');
    utils.setText('loadingMsg', 'Preparando datos...');

    // Progress bar animation
    this._animateProgress(0, 30, 800);

    try {
      // Preparar payload
      const payload = {
        action:        'punch',
        employee:      state.employee,
        punchType:     state.punchType,
        datetime:      utils.formatDateTime(now),
        timestamp:     now.toISOString(),
        lat:           state.gpsCoords?.lat?.toFixed(7) || '',
        lng:           state.gpsCoords?.lng?.toFixed(7) || '',
        accuracy:      state.gpsCoords?.accuracy?.toFixed(1) || '',
        distanceM:     Math.round(state.gpsDistance || 0),
        gpsStatus:     state.gpsAllowed ? 'DENTRO_ZONA' : 'HOME_OFFICE',
        mode:          state.mode,
        isLate:        utils.isLate(now) ? 'SI' : 'NO',
        observation:   state.mode === 'obra' ? `[OBRA: ${state.address}] ${state.observation}` : state.observation,
        selfieData:    state.selfieDataURL || '',
        selfieSkipped: state.selfieSkipped ? 'SI' : 'NO',
        userAgent:     navigator.userAgent,
        logs:          JSON.stringify(state.logs.slice(-10)),
      };

      utils.setText('loadingMsg', 'Enviando datos al servidor...');
      this._animateProgress(30, 70, 1200);

      // Enviar a Apps Script
      const result = await api.sendPunch(payload);

      this._animateProgress(70, 100, 500);
      await utils.sleep(600);

      if (result.success) {
        antiFraud.recordPunch(state.employee, state.punchType);
        antiFraud.recordDevicePunch(state.employee);
        utils.log('info', 'Punch recorded successfully', result);
        this._showResult(true, result, now);
      } else {
        throw new Error(result.message || 'El servidor rechazó la fichada.');
      }

    } catch(err) {
      utils.log('error', 'Punch submission failed', err.message);
      this._animateProgress(0, 0, 0);
      this._showResult(false, { message: err.message }, now);
    }
  },

  _animateProgress(from, to, duration) {
    const bar = document.getElementById('loadingProgress');
    if (!bar) return;
    const start = performance.now();
    const animate = (now) => {
      const elapsed = now - start;
      const pct = Math.min(from + (to - from) * (elapsed / duration), to);
      bar.style.width = pct + '%';
      if (elapsed < duration) requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  },

  _showResult(success, data, now) {
    const typeLabels = {
      ENTRADA: 'Entrada registrada',
      SALIDA: 'Salida registrada',
      INICIO_ALMUERZO: 'Inicio de almuerzo',
      FIN_ALMUERZO: 'Fin de almuerzo',
    };

    const lateMsg = utils.isLate(now) ? '⚠️ Llegada tarde registrada.' : '';

    const html = success ? `
      <div class="result-icon success">✅</div>
      <h2 class="result-title" style="color:var(--accent-success)">¡Fichada exitosa!</h2>
      <p class="result-sub">${typeLabels[state.punchType] || state.punchType} registrado correctamente.<br>${lateMsg}</p>
      <div class="result-details">
        <div class="result-detail-row"><span class="key">👤 Empleado</span><span class="val">${state.employee}</span></div>
        <div class="result-detail-row"><span class="key">📋 Tipo</span><span class="val">${typeLabels[state.punchType] || state.punchType}</span></div>
        <div class="result-detail-row"><span class="key">🕐 Hora</span><span class="val">${utils.formatTime(now)}</span></div>
        <div class="result-detail-row"><span class="key">📍 Distancia</span><span class="val">${utils.formatDistance(state.gpsDistance || 0)}</span></div>
        <div class="result-detail-row"><span class="key">🏷️ Modo</span><span class="val">${state.mode}</span></div>
        ${data.rowNumber ? `<div class="result-detail-row"><span class="key"># Registro</span><span class="val">${data.rowNumber}</span></div>` : ''}
      </div>
    ` : `
      <div class="result-icon error">❌</div>
      <h2 class="result-title" style="color:var(--accent-danger)">Error al fichar</h2>
      <p class="result-sub">No se pudo registrar la fichada.<br><small style="color:var(--text-muted)">${data.message || 'Error desconocido'}</small></p>
      <div style="margin-top:var(--space-4)">
        <button class="btn btn-ghost btn-full" onclick="app.retryPunch()">🔄 Reintentar</button>
      </div>
    `;

    utils.setHTML('resultCard', html);
    this.showScreen('screenResult');
    utils.log('info', `Result shown: ${success ? 'SUCCESS' : 'ERROR'}`);
  },

  /* ── Reintentar envío ────────────────────────────────────── */
  async retryPunch() {
    this.showScreen('screenPunch');
  },

  /* ── Reset completo ──────────────────────────────────────── */
  resetToStart() {
    // Limpiar estado
    state.gpsCoords    = null;
    state.gpsDistance  = null;
    state.gpsAllowed   = false;
    state.gpsGranted   = false;
    state.selfieDataURL = null;
    state.selfieSkipped = false;
    state.punchType    = null;
    state.employee     = null;
    state.observation  = '';
    state.logs         = [];

    // Resetear formulario
    document.getElementById('employeeSelect').value = '';
    document.getElementById('observationInput').value = '';
    document.getElementById('addressInput').value = '';

    // Resetear mapa
    if (state.markerUser) { state.map?.removeLayer(state.markerUser); state.markerUser = null; }

    stepsUI.update(1);
    this.showScreen('screenWelcome');
    utils.log('info', 'App reset to start');
  },
};

/* ──────────────────────────────────────────────────────────────
   INICIAR AL CARGAR LA PÁGINA
──────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  app.init();
});

// Service Worker (PWA) — registro básico
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Service worker opcional; no interrumpir si falla
    });
  });
}
