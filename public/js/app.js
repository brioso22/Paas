// JavaScript del panel. Sin dependencias ni HTML dinámico: solo textContent.
(function () {
  'use strict';

  const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content || '';

  // Confirmación para formularios destructivos: <form data-confirm="¿Seguro?">
  document.addEventListener('submit', (ev) => {
    const msg = ev.target.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) ev.preventDefault();
  });

  // Copiar al portapapeles: <button data-copy="#id-del-input">
  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-copy]');
    if (!btn) return;
    const el = document.querySelector(btn.getAttribute('data-copy'));
    if (!el) return;
    try {
      await navigator.clipboard.writeText(el.value ?? el.textContent);
      flashText(btn, 'Copiado');
    } catch {
      el.select?.();
    }
  });

  // Revelar un secreto bajo demanda: <button data-reveal-url="/…" data-reveal-target="#input">
  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-reveal-url]');
    if (!btn) return;
    const target = document.querySelector(btn.getAttribute('data-reveal-target'));
    if (!target) return;
    if (target.dataset.revealed === '1') {
      target.type = 'password';
      target.value = '';
      target.dataset.revealed = '0';
      btn.textContent = 'Revelar';
      return;
    }
    if (!window.confirm('¿Mostrar el valor en pantalla? Asegúrate de que nadie más la está viendo.')) return;
    const res = await fetch(btn.getAttribute('data-reveal-url'), {
      method: 'POST',
      headers: { 'x-csrf-token': csrf(), accept: 'application/json' },
      credentials: 'same-origin',
    });
    if (!res.ok) return flashText(btn, 'Error');
    const data = await res.json();
    target.type = 'text';
    target.value = data.value;
    target.dataset.revealed = '1';
    btn.textContent = 'Ocultar';
  });

  // Filas dinámicas del editor de variables.
  document.addEventListener('click', (ev) => {
    const add = ev.target.closest('[data-add-row]');
    if (add) {
      const tpl = document.getElementById(add.getAttribute('data-add-row'));
      const list = document.querySelector(add.getAttribute('data-into'));
      if (tpl && list) list.appendChild(tpl.content.cloneNode(true));
    }
    const rm = ev.target.closest('[data-remove-row]');
    if (rm) rm.closest('.env-row')?.remove();
  });

  // Alternar campos según el origen (zip/git) en el formulario de proyecto.
  function syncSource() {
    const checked = document.querySelector('input[name="source"]:checked');
    if (!checked) return;
    document.querySelectorAll('[data-source]').forEach((el) => {
      const on = el.getAttribute('data-source') === checked.value;
      el.hidden = !on;
      el.querySelectorAll('input,select').forEach((i) => (i.disabled = !on));
    });
  }
  document.addEventListener('change', (ev) => {
    if (ev.target.name === 'source') syncSource();
    if (ev.target.matches('[data-toggle]')) syncToggles();
  });
  function syncToggles() {
    document.querySelectorAll('[data-toggle]').forEach((cb) => {
      document.querySelectorAll(cb.getAttribute('data-toggle')).forEach((el) => (el.hidden = !cb.checked));
    });
  }

  function flashText(el, text) {
    const old = el.textContent;
    el.textContent = text;
    setTimeout(() => (el.textContent = old), 1200);
  }

  // Visor de logs por Server-Sent Events: <pre data-stream="/deployments/1/stream">.
  // EventSource reconecta solo y envía Last-Event-ID, así el servidor reanuda donde se quedó.
  function attachStream(pre) {
    const url = pre.getAttribute('data-stream');
    const statusEl = document.querySelector(pre.getAttribute('data-status-target') || '#none');
    const autoscroll = () => {
      const nearBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 80;
      return nearBottom;
    };
    const es = new EventSource(url, { withCredentials: true });
    const append = (text, cls) => {
      const stick = autoscroll();
      const span = document.createElement('span');
      if (cls) span.className = cls;
      span.textContent = text + '\n';
      pre.appendChild(span);
      if (stick) pre.scrollTop = pre.scrollHeight;
    };
    es.addEventListener('line', (e) => {
      try {
        const d = JSON.parse(e.data);
        append(d.text, d.stream === 'stderr' ? 'stderr' : d.stream === 'meta' ? 'meta' : '');
      } catch {
        append(e.data);
      }
    });
    es.addEventListener('status', (e) => {
      if (!statusEl) return;
      statusEl.textContent = e.data;
      statusEl.className = 'badge badge-' + e.data;
    });
    es.addEventListener('end', (e) => {
      es.close();
      if (e.data) append('— ' + e.data + ' —', 'meta');
      if (pre.hasAttribute('data-reload-on-end')) setTimeout(() => location.reload(), 1500);
    });
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) append('— conexión cerrada —', 'meta');
    };
  }

  document.addEventListener('DOMContentLoaded', () => {
    syncSource();
    syncToggles();
    document.querySelectorAll('pre[data-stream]').forEach(attachStream);
  });
})();
