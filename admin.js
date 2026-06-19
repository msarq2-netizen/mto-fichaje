/* ============================================================
   MTO Servicios HVAC — Panel Administrativo
   admin.js — Dashboard, filtros, charts, exportación
   v1.0 — Producción
   ============================================================ */

'use strict';

/* ── Configuración ────────────────────────────────────────── */
const ADMIN_CONFIG = {
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbwXBd4Llb1snlaIA2akC3X_-QuBd2SLwhkk8zsEBonCud8OD1W0Mb2isAsOtT1Ulhaf4Q/exec',
  ADMIN_PIN: '1234',          // ← CAMBIAR en Codigo.gs también
  COMPANY_NAME: 'MTO Servicios HVAC',
  WORK_HOURS_PER_DAY: 8,     // horas laborales estándar
  MONTHS_ES: ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'],
  DAYS_ES: ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'],

  EMPLOYEE_SCHEDULES: {
    'AYELEN VECCHIARELLI': {
      startHour: 8, startMinute: 30,
      endHour: 17, endMinute: 30,
    },
    'GENOVEVA JURADO': {
      startHour: 8, startMinute: 0,
      endHour: 17, endMinute: 0,
      dayOverrides: {
        3: { endHour: 16, endMinute: 0, note: 'Salida acordada Mié 16:00' },
        5: { endHour: 16, endMinute: 0, note: 'Salida acordada Vie 16:00' },
      },
    },
  },
};

/* ── Estado global ────────────────────────────────────────── */
const adminState = {
  records: [],          // todos los registros desde Sheets
  filteredRecords: [],  // registros después de filtros
  charts: {},           // instancias Chart.js
  activeTab: 'records',
  isLoading: false,
};

/* ── Toast helper ─────────────────────────────────────────── */
const adminToast = {
  show(msg, type='info', dur=4000) {
    const icons = { success:'✅', error:'❌', info:'ℹ️', warning:'⚠️' };
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="toast-icon">${icons[type]||'ℹ️'}</span><span class="toast-msg">${msg}</span>`;
    document.getElementById('toastContainer').appendChild(el);
    setTimeout(() => { el.style.animation='toastOut 0.3s ease forwards'; setTimeout(()=>el.remove(),300); }, dur);
  },
  success(m,d){this.show(m,'success',d);},
  error(m,d)  {this.show(m,'error',d);},
  info(m,d)   {this.show(m,'info',d);},
  warning(m,d){this.show(m,'warning',d);},
};

/* ── Utilidades ───────────────────────────────────────────── */
const adminUtils = {
  parseDate(str) {
    // Soporta "DD/MM/YYYY HH:MM:SS", "DD/MM/YYYY, HH:MM:SS" y ISO
    if (!str) return null;
    str = String(str).trim().replace(/,/g, '');
    if (str.includes('/')) {
      const [datePart, timePart=''] = str.split(' ');
      const [d, m, y] = datePart.split('/');
      const dt = new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}T${timePart||'00:00:00'}`);
      // Si la fecha queda >3 meses en el futuro, probamos invertir día/mes
      // (Samsung Browser guarda en MM/DD en vez de DD/MM con locale es-AR)
      const cutoff = new Date(Date.now() + 90 * 24 * 3600 * 1000);
      if (dt > cutoff && parseInt(d) <= 12) {
        const swapped = new Date(`${y}-${d.padStart(2,'0')}-${m.padStart(2,'0')}T${timePart||'00:00:00'}`);
        if (!isNaN(swapped.getTime()) && swapped <= cutoff) return swapped;
      }
      return dt;
    }
    return new Date(str);
  },
  formatDate(date) {
    if (!date) return '—';
    return date.toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric' });
  },
  formatDateTime(date) {
    if (!date) return '—';
    return date.toLocaleString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
  },
  getInitials(name) {
    return (name||'?').split(' ').map(n=>n[0]).slice(0,2).join('').toUpperCase();
  },
  diffHours(dateA, dateB) {
    if (!dateA || !dateB) return 0;
    return Math.abs(dateB - dateA) / 3600000;
  },
  getSchedule(employee, date) {
    const sched = ADMIN_CONFIG.EMPLOYEE_SCHEDULES?.[employee];
    if (!sched) return null;
    const dow = date instanceof Date ? date.getDay() : -1;
    const override = sched.dayOverrides?.[dow];
    return override ? { ...sched, ...override } : sched;
  },
  isLateBySchedule(record) {
    if (record.punchType !== 'ENTRADA' || !record.datetime) return record.isLate;
    const sched = adminUtils.getSchedule(record.employee, record.datetime);
    if (!sched) return record.isLate;
    const punchMin = record.datetime.getHours() * 60 + record.datetime.getMinutes();
    const limitMin = sched.startHour * 60 + sched.startMinute + 15;
    return punchMin > limitMin;
  },
  scheduleNote(record) {
    if (record.punchType !== 'SALIDA' || !record.datetime) return '';
    const sched = adminUtils.getSchedule(record.employee, record.datetime);
    return sched?.note || '';
  },
  groupBy(arr, key) {
    return arr.reduce((acc, item) => {
      const k = typeof key === 'function' ? key(item) : item[key];
      (acc[k] = acc[k] || []).push(item);
      return acc;
    }, {});
  },
  dateKey(date) {
    if (!date) return '';
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  },
};

/* ──────────────────────────────────────────────────────────────
   DATOS — parseo y estadísticas
──────────────────────────────────────────────────────────────── */
const dataProcessor = {

  parseRow(row) {
    // row: array de columnas del Sheets
    // [0]Fecha/Hora [1]Empleado [2]Tipo [3]Lat [4]Lng [5]Distancia [6]GpsStatus [7]SelfieURL [8]Obs [9]Modo [10]Tarde
    return {
      datetime:    adminUtils.parseDate(row[0] || ''),
      employee:    row[1] || '',
      punchType:   row[2] || '',
      lat:         parseFloat(row[3]) || 0,
      lng:         parseFloat(row[4]) || 0,
      distance:    parseFloat(row[5]) || 0,
      gpsStatus:   row[6] || '',
      selfieURL:   row[7] || '',
      observation: row[8] || '',
      mode:        row[9] || 'oficina',
      isLate:      (row[10] || '').toUpperCase() === 'SI',
    };
  },

  computeStats(records) {
    const now = new Date();
    const todayKey = adminUtils.dateKey(now);
    const currentMonth = now.getMonth();
    const currentYear  = now.getFullYear();

    const today    = records.filter(r => adminUtils.dateKey(r.datetime) === todayKey);
    const thisMonth= records.filter(r => r.datetime && r.datetime.getMonth()===currentMonth && r.datetime.getFullYear()===currentYear);
    const lateRecs = records.filter(r => r.isLate && r.punchType === 'ENTRADA');
    const employees= [...new Set(records.map(r=>r.employee).filter(Boolean))];
    const hoRecs   = records.filter(r => r.mode === 'homeoffice');
    const obraRecs = records.filter(r => r.mode === 'obra');

    return { today, thisMonth, lateRecs, employees, hoRecs, obraRecs };
  },

  computeEmployeeStats(employeeName, records) {
    const empRecs = records.filter(r => r.employee === employeeName);
    const entriesByDay = adminUtils.groupBy(empRecs.filter(r=>r.punchType==='ENTRADA'), r => adminUtils.dateKey(r.datetime));
    const exitsByDay   = adminUtils.groupBy(empRecs.filter(r=>r.punchType==='SALIDA'),  r => adminUtils.dateKey(r.datetime));

    let totalHours = 0;
    let workedDays = 0;

    // Calcular horas por día (entrada-salida)
    Object.keys(entriesByDay).forEach(dayKey => {
      if (exitsByDay[dayKey]) {
        const entry = entriesByDay[dayKey][0].datetime;
        const exit  = exitsByDay[dayKey][0].datetime;
        if (entry && exit && exit > entry) {
          const hours = adminUtils.diffHours(entry, exit);
          // Descontar almuerzos si existen
          const lunchStart = empRecs.find(r => r.punchType==='INICIO_ALMUERZO' && adminUtils.dateKey(r.datetime)===dayKey);
          const lunchEnd   = empRecs.find(r => r.punchType==='FIN_ALMUERZO'   && adminUtils.dateKey(r.datetime)===dayKey);
          const lunchHours = (lunchStart && lunchEnd && lunchEnd.datetime > lunchStart.datetime)
            ? adminUtils.diffHours(lunchStart.datetime, lunchEnd.datetime) : 1; // asumir 1h si no hay registro
          totalHours += Math.max(0, hours - lunchHours);
          workedDays++;
        }
      }
    });

    const lateCount   = empRecs.filter(r => adminUtils.isLateBySchedule(r)).length;
    const punchCount  = empRecs.length;
    const hoCount     = empRecs.filter(r => r.mode==='homeoffice').length;
    const obraCount   = empRecs.filter(r => r.mode==='obra').length;
    const extraHours  = Math.max(0, totalHours - (workedDays * ADMIN_CONFIG.WORK_HOURS_PER_DAY));

    return { employeeName, punchCount, workedDays, totalHours: totalHours.toFixed(1), lateCount, hoCount, obraCount, extraHours: extraHours.toFixed(1) };
  },
};

/* ──────────────────────────────────────────────────────────────
   GRÁFICOS (Chart.js)
──────────────────────────────────────────────────────────────── */
const chartsManager = {

  defaults: {
    color: 'rgba(241,245,249,0.85)',
    grid: 'rgba(255,255,255,0.06)',
    font: { family: "'Inter', sans-serif", size: 11 },
  },

  destroyAll() {
    Object.values(adminState.charts).forEach(c => { try { c.destroy(); } catch(e){} });
    adminState.charts = {};
  },

  buildDailyChart(records) {
    const ctx = document.getElementById('chartDaily');
    if (!ctx) return;
    const last14 = [];
    const now = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      last14.push(adminUtils.dateKey(d));
    }
    const labels  = last14.map(k => k.slice(5)); // MM-DD
    const data    = last14.map(k => records.filter(r => adminUtils.dateKey(r.datetime) === k).length);

    if (adminState.charts.daily) adminState.charts.daily.destroy();
    adminState.charts.daily = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Fichadas',
          data,
          backgroundColor: 'rgba(59,130,246,0.5)',
          borderColor: 'rgba(59,130,246,0.9)',
          borderWidth: 1,
          borderRadius: 4,
        }]
      },
      options: this._commonOptions('Fichadas por día'),
    });
  },

  buildTypesChart(records) {
    const ctx = document.getElementById('chartTypes');
    if (!ctx) return;
    const tipos = ['ENTRADA','SALIDA','INICIO_ALMUERZO','FIN_ALMUERZO'];
    const counts = tipos.map(t => records.filter(r => r.punchType===t).length);
    if (adminState.charts.types) adminState.charts.types.destroy();
    adminState.charts.types = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Entrada','Salida','Inicio Almuerzo','Fin Almuerzo'],
        datasets: [{ data: counts,
          backgroundColor: ['rgba(16,185,129,0.7)','rgba(239,68,68,0.7)','rgba(245,158,11,0.7)','rgba(99,102,241,0.7)'],
          borderColor: ['#10b981','#ef4444','#f59e0b','#6366f1'],
          borderWidth: 2,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: this.defaults.color, font: this.defaults.font } },
        },
        cutout: '65%',
      },
    });
  },

  buildEmployeeChart(records) {
    const ctx = document.getElementById('chartEmployee');
    if (!ctx) return;
    const now = new Date();
    const thisMonthRecs = records.filter(r => r.datetime && r.datetime.getMonth()===now.getMonth() && r.datetime.getFullYear()===now.getFullYear());
    const grouped = adminUtils.groupBy(thisMonthRecs, 'employee');
    const sorted = Object.entries(grouped).sort((a,b)=>b[1].length-a[1].length).slice(0,8);
    if (adminState.charts.employee) adminState.charts.employee.destroy();
    adminState.charts.employee = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: sorted.map(([name]) => name.split(' ')[0]),
        datasets: [{ label: 'Fichadas', data: sorted.map(([,recs])=>recs.length),
          backgroundColor: 'rgba(99,102,241,0.5)', borderColor: 'rgba(99,102,241,0.9)',
          borderWidth: 1, borderRadius: 4 }]
      },
      options: { ...this._commonOptions('Por empleado'), indexAxis: 'y' },
    });
  },

  buildPunctualityChart(records) {
    const ctx = document.getElementById('chartPunctuality');
    if (!ctx) return;
    const now = new Date();
    const entries = records.filter(r => r.punchType==='ENTRADA' && r.datetime && r.datetime.getMonth()===now.getMonth());
    const late   = entries.filter(r => r.isLate).length;
    const onTime = entries.length - late;
    if (adminState.charts.punctuality) adminState.charts.punctuality.destroy();
    adminState.charts.punctuality = new Chart(ctx, {
      type: 'pie',
      data: {
        labels: ['A tiempo','Tarde'],
        datasets: [{ data: [onTime, late],
          backgroundColor: ['rgba(16,185,129,0.7)','rgba(245,158,11,0.7)'],
          borderColor: ['#10b981','#f59e0b'], borderWidth: 2 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: this.defaults.color, font: this.defaults.font } } },
      },
    });
  },

  _commonOptions(title) {
    const d = this.defaults;
    return {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        title: { display: false },
        tooltip: { backgroundColor: 'rgba(13,18,38,0.95)', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, titleFont: d.font, bodyFont: d.font },
      },
      scales: {
        x: { ticks: { color: d.color, font: d.font }, grid: { color: d.grid } },
        y: { ticks: { color: d.color, font: d.font }, grid: { color: d.grid } },
      },
    };
  },
};

/* ──────────────────────────────────────────────────────────────
   EXPORTACIÓN
──────────────────────────────────────────────────────────────── */
const exporter = {

  toCSV(records) {
    const headers = ['Fecha/Hora','Empleado','Tipo','Modo','Distancia(m)','GPS','Tarde','Observación'];
    const rows = records.map(r => [
      r.datetime ? adminUtils.formatDateTime(r.datetime) : '—',
      r.employee, r.punchType, r.mode,
      Math.round(r.distance), r.gpsStatus,
      r.isLate ? 'SI' : 'NO',
      `"${(r.observation||'').replace(/"/g,'""')}"`,
    ]);
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `MTO_HVAC_Asistencia_${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
    adminToast.success('CSV exportado correctamente.');
  },

  toPDF(records, stats) {
    // PDF via print stylesheet
    const printWin = window.open('', '_blank');
    const rows = records.slice(0, 200).map(r => `
      <tr>
        <td>${r.datetime ? adminUtils.formatDateTime(r.datetime) : '—'}</td>
        <td>${r.employee}</td>
        <td>${r.punchType}</td>
        <td>${r.mode}</td>
        <td>${Math.round(r.distance)}m</td>
        <td>${r.isLate ? '<b style="color:#f59e0b">TARDE</b>' : '✓'}</td>
        <td>${r.observation||'—'}</td>
      </tr>`).join('');
    printWin.document.write(`
      <!DOCTYPE html><html><head><meta charset="UTF-8">
      <title>MTO HVAC — Reporte de Asistencia</title>
      <style>
        body{font-family:system-ui,sans-serif;font-size:11px;color:#1a1a2e;padding:20px;}
        h1{font-size:18px;margin-bottom:4px;} h2{font-size:13px;color:#555;margin-bottom:16px;}
        table{border-collapse:collapse;width:100%;}
        th{background:#0a0f1e;color:#fff;padding:6px 8px;text-align:left;font-size:10px;}
        td{padding:5px 8px;border-bottom:1px solid #eee;}
        tr:nth-child(even){background:#f8f9fa;}
        .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px;}
        .stat{background:#f0f4ff;padding:10px;border-radius:8px;}
        .stat b{display:block;font-size:22px;color:#0a0f1e;}
        .stat span{font-size:10px;color:#666;}
        @media print{body{padding:0;}}
      </style></head><body>
      <h1>📊 Reporte de Asistencia — ${ADMIN_CONFIG.COMPANY_NAME}</h1>
      <h2>Generado: ${new Date().toLocaleString('es-AR')}</h2>
      <div class="stats">
        <div class="stat"><b>${stats.today.length}</b><span>Fichadas hoy</span></div>
        <div class="stat"><b>${stats.thisMonth.length}</b><span>Este mes</span></div>
        <div class="stat"><b>${stats.lateRecs.length}</b><span>Llegadas tarde</span></div>
        <div class="stat"><b>${stats.employees.length}</b><span>Empleados</span></div>
      </div>
      <table>
        <thead><tr><th>Fecha/Hora</th><th>Empleado</th><th>Tipo</th><th>Modo</th><th>Distancia</th><th>Tarde</th><th>Observación</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin-top:16px;color:#999;font-size:10px;">Mostrando ${Math.min(records.length,200)} de ${records.length} registros.</p>
      </body></html>`);
    printWin.document.close();
    setTimeout(() => printWin.print(), 500);
  },
};

/* ──────────────────────────────────────────────────────────────
   APP ADMIN PRINCIPAL
──────────────────────────────────────────────────────────────── */
const adminApp = {

  /* ── Login ────────────────────────────────────────────────── */
  login() {
    const pin = document.getElementById('adminPinInput').value.trim();
    if (pin === ADMIN_CONFIG.ADMIN_PIN) {
      document.getElementById('adminLogin').style.display = 'none';
      document.getElementById('adminDashboard').style.display = 'block';
      this.init();
    } else {
      adminToast.error('PIN incorrecto. Intentá de nuevo.');
      document.getElementById('adminPinInput').value = '';
      document.getElementById('adminPinInput').focus();
    }
  },

  logout() {
    document.getElementById('adminDashboard').style.display = 'none';
    document.getElementById('adminLogin').style.display = 'flex';
    document.getElementById('adminPinInput').value = '';
    adminState.records = [];
    adminState.filteredRecords = [];
    chartsManager.destroyAll();
  },

  /* ── Inicializar ──────────────────────────────────────────── */
  async init() {
    this._populateMonthYearFilters();
    await this.loadData();
  },

  _populateMonthYearFilters() {
    const now = new Date();
    const monthSel = document.getElementById('empFilterMonth');
    if (!monthSel) return;
    ADMIN_CONFIG.MONTHS_ES.forEach((m, i) => {
      const opt = document.createElement('option');
      opt.value = i; opt.textContent = m;
      if (i === now.getMonth()) opt.selected = true;
      monthSel.appendChild(opt);
    });
    const yearSel = document.getElementById('empFilterYear');
    for (let y = now.getFullYear(); y >= now.getFullYear()-3; y--) {
      const opt = document.createElement('option');
      opt.value = y; opt.textContent = y;
      if (y === now.getFullYear()) opt.selected = true;
      yearSel.appendChild(opt);
    }
  },

  /* ── Cargar datos desde Apps Script ──────────────────────── */
  async loadData() {
    if (adminState.isLoading) return;
    adminState.isLoading = true;
    const btn = document.getElementById('btnRefresh');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Cargando...'; }

    try {
      const url = `${ADMIN_CONFIG.APPS_SCRIPT_URL}?action=getData&ts=${Date.now()}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      if (!data.success) throw new Error(data.message || 'Error del servidor');

      // Parsear filas
      adminState.records = (data.rows || [])
        .filter(r => r && r[0])
        .map(r => dataProcessor.parseRow(r))
        .filter(r => r.datetime && !isNaN(r.datetime.getTime()))
        .sort((a,b) => b.datetime - a.datetime);

      adminState.filteredRecords = [...adminState.records];

      const stats = dataProcessor.computeStats(adminState.records);
      this._updateStats(stats);
      this._populateEmployeeFilter();
      this.applyFilters();
      this.renderCharts();
      this.renderEmployeesTab();
      this.renderRanking();

      const lastUpdate = new Date().toLocaleTimeString('es-AR');
      document.getElementById('dashSubtitle').textContent =
        `${ADMIN_CONFIG.COMPANY_NAME} · ${adminState.records.length} registros · Actualizado ${lastUpdate}`;

      adminToast.success(`${adminState.records.length} registros cargados.`);

    } catch(err) {
      console.error('Load data error:', err);
      adminToast.error(`Error al cargar datos: ${err.message}`);
      document.getElementById('dashSubtitle').textContent = 'Error al cargar datos. Verificá la URL del script.';

      // Demo data en caso de error (para preview)
      this._loadDemoData();
    } finally {
      adminState.isLoading = false;
      if (btn) { btn.disabled = false; btn.textContent = '🔄 Actualizar'; }
    }
  },

  _loadDemoData() {
    const employees = ['Ana García','Carlos López','María Pérez','Roberto Silva','Florencia Díaz'];
    const types = ['ENTRADA','SALIDA','INICIO_ALMUERZO','FIN_ALMUERZO'];
    const modes = ['oficina','oficina','oficina','homeoffice','obra'];
    const demo = [];
    const now = new Date();

    for (let d = 0; d < 30; d++) {
      const date = new Date(now); date.setDate(date.getDate() - d);
      if (date.getDay() === 0 || date.getDay() === 6) continue;
      employees.forEach(emp => {
        if (Math.random() > 0.15) {
          const hour = 8 + Math.floor(Math.random() * 2 - 0.3);
          const min  = Math.floor(Math.random() * 60);
          const entryDate = new Date(date); entryDate.setHours(hour, min, 0);
          const mode = modes[Math.floor(Math.random() * modes.length)];
          demo.push({ datetime: entryDate, employee: emp, punchType: 'ENTRADA', lat: -34.6037, lng: -58.3816, distance: Math.random()*120, gpsStatus: 'DENTRO_ZONA', selfieURL: '', observation: '', mode, isLate: (hour === 8 && min > 15) || hour > 8 });
          const exitDate = new Date(date); exitDate.setHours(17 + Math.floor(Math.random()*2), Math.floor(Math.random()*60), 0);
          demo.push({ datetime: exitDate, employee: emp, punchType: 'SALIDA', lat: -34.6037, lng: -58.3816, distance: Math.random()*120, gpsStatus: 'DENTRO_ZONA', selfieURL: '', observation: '', mode, isLate: false });
        }
      });
    }

    adminState.records = demo.sort((a,b) => b.datetime - a.datetime);
    adminState.filteredRecords = [...adminState.records];
    const stats = dataProcessor.computeStats(adminState.records);
    this._updateStats(stats);
    this._populateEmployeeFilter();
    this.applyFilters();
    this.renderCharts();
    this.renderEmployeesTab();
    this.renderRanking();
    document.getElementById('dashSubtitle').textContent = `${ADMIN_CONFIG.COMPANY_NAME} · Datos demo (script no conectado)`;
    adminToast.warning('Mostrando datos de demo. Conectá tu Apps Script para ver datos reales.');
  },

  _updateStats(stats) {
    document.getElementById('statToday').textContent     = stats.today.length;
    document.getElementById('statTodayChange').textContent = `${[...new Set(stats.today.map(r=>r.employee))].length} empleados hoy`;
    document.getElementById('statMonth').textContent     = stats.thisMonth.length;
    document.getElementById('statMonthChange').textContent = `${ADMIN_CONFIG.MONTHS_ES[new Date().getMonth()]}`;
    document.getElementById('statLate').textContent      = stats.lateRecs.length;
    document.getElementById('statLateChange').textContent = `Mes actual`;
    document.getElementById('statEmployees').textContent = stats.employees.length;
    document.getElementById('statEmployeesChange').textContent = `Con registros`;
    document.getElementById('statHO').textContent        = stats.hoRecs.length;
    document.getElementById('statObra').textContent      = stats.obraRecs.length;
  },

  _populateEmployeeFilter() {
    const sel = document.getElementById('filterEmployee');
    const current = sel.value;
    while (sel.options.length > 1) sel.remove(1);
    const employees = [...new Set(adminState.records.map(r=>r.employee))].sort();
    employees.forEach(emp => {
      const opt = document.createElement('option');
      opt.value = emp; opt.textContent = emp;
      if (emp === current) opt.selected = true;
      sel.appendChild(opt);
    });
  },

  /* ── Filtros ──────────────────────────────────────────────── */
  applyFilters() {
    const emp  = document.getElementById('filterEmployee')?.value || '';
    const type = document.getElementById('filterType')?.value || '';
    const from = document.getElementById('filterDateFrom')?.value ? new Date(document.getElementById('filterDateFrom').value) : null;
    const to   = document.getElementById('filterDateTo')?.value   ? new Date(document.getElementById('filterDateTo').value + 'T23:59:59') : null;
    const mode = document.getElementById('filterMode')?.value || '';

    adminState.filteredRecords = adminState.records.filter(r => {
      if (emp  && r.employee  !== emp)  return false;
      if (type && r.punchType !== type) return false;
      if (mode && r.mode      !== mode) return false;
      if (from && r.datetime  < from)   return false;
      if (to   && r.datetime  > to)     return false;
      return true;
    });

    this.renderRecordsTable();
  },

  clearFilters() {
    ['filterEmployee','filterType','filterDateFrom','filterDateTo','filterMode'].forEach(id => {
      const el = document.getElementById(id); if(el) el.value = '';
    });
    adminState.filteredRecords = [...adminState.records];
    this.renderRecordsTable();
  },

  /* ── Tabla de registros ───────────────────────────────────── */
  renderRecordsTable() {
    const tbody = document.getElementById('recordsTable');
    const count = document.getElementById('recordsCount');
    const recs  = adminState.filteredRecords;

    count.textContent = `Mostrando ${recs.length} de ${adminState.records.length} registros`;

    if (recs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:var(--space-8);color:var(--text-muted);">Sin registros para el filtro seleccionado.</td></tr>';
      return;
    }

    const typeLabels = { ENTRADA:'🟢 Entrada', SALIDA:'🔴 Salida', INICIO_ALMUERZO:'🍽️ Inicio Alm.', FIN_ALMUERZO:'🔄 Fin Alm.' };
    const modeLabels = { oficina:'🏢', homeoffice:'🏠', obra:'🔧' };

    tbody.innerHTML = recs.slice(0, 500).map((r, i) => `
      <tr>
        <td style="color:var(--text-muted);font-size:var(--fs-xs);">${adminState.records.length - adminState.records.indexOf(r)}</td>
        <td style="white-space:nowrap;">
          <div style="font-weight:500;">${r.datetime ? adminUtils.formatDate(r.datetime) : '—'}</div>
          <div style="color:var(--text-muted);font-size:var(--fs-xs);">${r.datetime ? r.datetime.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '—'}</div>
        </td>
        <td>
          <div style="display:flex;align-items:center;gap:8px;">
            <div style="width:28px;height:28px;border-radius:50%;background:var(--accent-gradient);display:grid;place-items:center;font-size:10px;font-weight:700;flex-shrink:0;">${adminUtils.getInitials(r.employee)}</div>
            <span class="truncate">${r.employee}</span>
          </div>
        </td>
        <td>${typeLabels[r.punchType] || r.punchType}</td>
        <td><span class="badge badge-gray">${modeLabels[r.mode]||'?'} ${r.mode}</span></td>
        <td>${r.distance ? Math.round(r.distance)+'m' : '—'}</td>
        <td><span class="badge ${r.gpsStatus==='DENTRO_ZONA'?'badge-green':'badge-yellow'}">${r.gpsStatus==='DENTRO_ZONA'?'✓ OK':'🏠 HO'}</span></td>
        <td>${adminUtils.isLateBySchedule(r) ? '<span class="badge badge-yellow">⚠️ Tarde</span>' : '<span class="badge badge-green">✓</span>'}</td>
        <td>${r.selfieURL ? `<img src="${r.selfieURL}" class="selfie-thumb" onclick="adminApp.openSelfie('${r.selfieURL}')" title="Ver selfie" onerror="this.style.display='none'">` : '<span style="color:var(--text-muted);font-size:var(--fs-xs);">—</span>'}</td>
        <td style="max-width:160px;"><span class="truncate" title="${r.observation||''}">${[adminUtils.scheduleNote(r), r.observation].filter(Boolean).join(' · ') || '—'}</span></td>
      </tr>`).join('');
  },

  /* ── Tab empleados ────────────────────────────────────────── */
  renderEmployeesTab() {
    const grid = document.getElementById('employeesGrid');
    const monthFilter = parseInt(document.getElementById('empFilterMonth')?.value ?? '-1');
    const yearFilter  = parseInt(document.getElementById('empFilterYear')?.value  ?? '-1');

    let records = adminState.records;
    if (!isNaN(monthFilter) && document.getElementById('empFilterMonth')?.value !== '') {
      records = records.filter(r => r.datetime && r.datetime.getMonth() === monthFilter);
    }
    if (!isNaN(yearFilter) && document.getElementById('empFilterYear')?.value !== '') {
      records = records.filter(r => r.datetime && r.datetime.getFullYear() === yearFilter);
    }

    const employees = [...new Set(records.map(r=>r.employee))].sort();
    if (employees.length === 0) {
      grid.innerHTML = '<div style="color:var(--text-muted);grid-column:1/-1;text-align:center;padding:var(--space-8);">Sin datos para el período seleccionado.</div>';
      return;
    }

    grid.innerHTML = employees.map(emp => {
      const s = dataProcessor.computeEmployeeStats(emp, records);
      const lateClass = s.lateCount > 3 ? 'badge-red' : s.lateCount > 0 ? 'badge-yellow' : 'badge-green';
      return `
        <div class="employee-card">
          <div style="display:flex;align-items:center;gap:var(--space-3);margin-bottom:var(--space-4);">
            <div class="employee-avatar">${adminUtils.getInitials(emp)}</div>
            <div>
              <div style="font-weight:700;font-size:var(--fs-base);">${emp}</div>
              <div style="font-size:var(--fs-xs);color:var(--text-muted);">${s.punchCount} fichadas · ${s.workedDays} días</div>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-2);">
            <div style="background:var(--bg-glass);border-radius:var(--radius-md);padding:var(--space-3);border:1px solid var(--border-subtle);">
              <div style="font-size:var(--fs-xs);color:var(--text-muted);margin-bottom:2px;">Horas trabajadas</div>
              <div style="font-size:var(--fs-xl);font-weight:800;">${s.totalHours}h</div>
            </div>
            <div style="background:var(--bg-glass);border-radius:var(--radius-md);padding:var(--space-3);border:1px solid var(--border-subtle);">
              <div style="font-size:var(--fs-xs);color:var(--text-muted);margin-bottom:2px;">Horas extra</div>
              <div style="font-size:var(--fs-xl);font-weight:800;color:${s.extraHours>0?'var(--accent-success)':'var(--text-muted)'};">${s.extraHours}h</div>
            </div>
          </div>
          <div style="display:flex;gap:var(--space-2);margin-top:var(--space-3);flex-wrap:wrap;">
            <span class="badge ${lateClass}">⚠️ ${s.lateCount} tarde${s.lateCount!==1?'s':''}</span>
            ${s.hoCount>0  ? `<span class="badge badge-blue">🏠 ${s.hoCount} HO</span>` : ''}
            ${s.obraCount>0? `<span class="badge badge-purple">🔧 ${s.obraCount} obra</span>` : ''}
          </div>
        </div>`;
    }).join('');
  },

  /* ── Gráficos ─────────────────────────────────────────────── */
  renderCharts() {
    setTimeout(() => {
      chartsManager.buildDailyChart(adminState.records);
      chartsManager.buildTypesChart(adminState.records);
      chartsManager.buildEmployeeChart(adminState.records);
      chartsManager.buildPunctualityChart(adminState.records);
    }, 100);
  },

  /* ── Ranking ──────────────────────────────────────────────── */
  renderRanking() {
    const now = new Date();
    const thisMonthRecs = adminState.records.filter(r =>
      r.datetime && r.datetime.getMonth()===now.getMonth() && r.datetime.getFullYear()===now.getFullYear()
    );

    const employees = [...new Set(thisMonthRecs.map(r=>r.employee))].sort();
    const empStats  = employees.map(emp => dataProcessor.computeEmployeeStats(emp, thisMonthRecs));

    // Ranking puntualidad (menos tardanzas)
    const rankPunctual = [...empStats].sort((a,b) => a.lateCount-b.lateCount);
    document.getElementById('rankingPunctual').innerHTML = rankPunctual.slice(0,5).map((s,i) => `
      <div style="display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3) 0;border-bottom:1px solid var(--border-subtle);">
        <span class="rank-num rank-${i+1}">${['🥇','🥈','🥉','4','5'][i]}</span>
        <div style="width:32px;height:32px;border-radius:50%;background:var(--accent-gradient);display:grid;place-items:center;font-size:10px;font-weight:700;">${adminUtils.getInitials(s.employeeName)}</div>
        <div style="flex:1;"><div style="font-weight:600;font-size:var(--fs-sm);">${s.employeeName}</div></div>
        <span class="badge badge-green">${s.lateCount} tardanzas</span>
      </div>`).join('') || '<p style="color:var(--text-muted);font-size:var(--fs-sm);">Sin datos</p>';

    // Más tardanzas
    const rankLate = [...empStats].sort((a,b) => b.lateCount-a.lateCount).filter(s=>s.lateCount>0);
    document.getElementById('rankingLate').innerHTML = rankLate.slice(0,5).map((s,i) => `
      <div style="display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3) 0;border-bottom:1px solid var(--border-subtle);">
        <span class="rank-num" style="color:var(--accent-warning);">${i+1}°</span>
        <div style="width:32px;height:32px;border-radius:50%;background:var(--accent-gradient);display:grid;place-items:center;font-size:10px;font-weight:700;">${adminUtils.getInitials(s.employeeName)}</div>
        <div style="flex:1;"><div style="font-weight:600;font-size:var(--fs-sm);">${s.employeeName}</div></div>
        <span class="badge badge-yellow">⚠️ ${s.lateCount}</span>
      </div>`).join('') || '<p style="color:var(--accent-success);font-size:var(--fs-sm);">¡Sin tardanzas este mes! 🎉</p>';

    // Más horas
    const rankHours = [...empStats].sort((a,b) => parseFloat(b.totalHours)-parseFloat(a.totalHours));
    document.getElementById('rankingHours').innerHTML = rankHours.slice(0,5).map((s,i) => `
      <div style="display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3) 0;border-bottom:1px solid var(--border-subtle);">
        <span class="rank-num rank-${i+1}">${['🥇','🥈','🥉','4','5'][i]}</span>
        <div style="width:32px;height:32px;border-radius:50%;background:var(--accent-gradient);display:grid;place-items:center;font-size:10px;font-weight:700;">${adminUtils.getInitials(s.employeeName)}</div>
        <div style="flex:1;"><div style="font-weight:600;font-size:var(--fs-sm);">${s.employeeName}</div></div>
        <span class="badge badge-blue">${s.totalHours}h</span>
      </div>`).join('') || '<p style="color:var(--text-muted);font-size:var(--fs-sm);">Sin datos</p>';

    // Ausencias (días sin entrada en días hábiles)
    const workDaysThisMonth = this._getWorkDays(now.getFullYear(), now.getMonth());
    const rankAbsent = employees.map(emp => {
      const empDays = new Set(thisMonthRecs.filter(r=>r.employee===emp && r.punchType==='ENTRADA').map(r=>adminUtils.dateKey(r.datetime)));
      const absent  = workDaysThisMonth.filter(d => !empDays.has(d)).length;
      return { employeeName: emp, absent };
    }).sort((a,b)=>b.absent-a.absent).filter(s=>s.absent>0);
    document.getElementById('rankingAbsent').innerHTML = rankAbsent.slice(0,5).map((s,i) => `
      <div style="display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3) 0;border-bottom:1px solid var(--border-subtle);">
        <span class="rank-num" style="color:var(--accent-danger);">${i+1}°</span>
        <div style="width:32px;height:32px;border-radius:50%;background:var(--accent-gradient);display:grid;place-items:center;font-size:10px;font-weight:700;">${adminUtils.getInitials(s.employeeName)}</div>
        <div style="flex:1;"><div style="font-weight:600;font-size:var(--fs-sm);">${s.employeeName}</div></div>
        <span class="badge badge-red">❌ ${s.absent} días</span>
      </div>`).join('') || '<p style="color:var(--accent-success);font-size:var(--fs-sm);">¡Sin ausencias detectadas! 🎉</p>';
  },

  _getWorkDays(year, month) {
    const days = [];
    const today = new Date();
    const daysInMonth = new Date(year, month+1, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(year, month, d);
      if (date > today) break;
      const dow = date.getDay();
      if (dow !== 0 && dow !== 6) days.push(adminUtils.dateKey(date));
    }
    return days;
  },

  /* ── Tabs ─────────────────────────────────────────────────── */
  switchTab(tab) {
    adminState.activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById(`tab${tab.charAt(0).toUpperCase()+tab.slice(1)}`);
    if (panel) panel.classList.add('active');
    if (tab === 'charts') this.renderCharts();
  },

  /* ── Selfie modal ─────────────────────────────────────────── */
  openSelfie(url) {
    const modal = document.getElementById('selfieModal');
    document.getElementById('selfieModalImg').src = url;
    modal.style.display = 'flex';
    modal.classList.add('open');
  },

  /* ── Exportación ──────────────────────────────────────────── */
  exportCSV() { exporter.toCSV(adminState.filteredRecords); },
  exportPDF()  {
    const stats = dataProcessor.computeStats(adminState.records);
    exporter.toPDF(adminState.filteredRecords, stats);
  },
};

/* ── Auto-submit con Enter en login ───────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('adminPinInput')?.focus();
});
