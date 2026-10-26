// JavaScript del panel. Sin dependencias ni HTML dinámico: solo textContent.
(function () {
  'use strict';

  const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content || '';

  // --- Modal de confirmación (<dialog>), construido con DOM y textContent --------
  function confirmDialog(message, { danger = true, okLabel = 'Confirmar' } = {}) {
    return new Promise((resolve) => {
      if (typeof HTMLDialogElement !== 'function') return resolve(window.confirm(message));
      const dlg = document.createElement('dialog');
      dlg.className = 'modal';
      dlg.setAttribute('aria-labelledby', 'modal-title');
      const h = document.createElement('h2');
      h.id = 'modal-title';
      h.textContent = danger ? 'Confirmar acción' : 'Confirmar';
      const p = document.createElement('p');
      p.textContent = message;
      const row = document.createElement('div');
      row.className = 'row';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn';
      cancel.textContent = 'Cancelar';
      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = danger ? 'btn btn-danger solid' : 'btn btn-primary';
      ok.textContent = okLabel;
      row.append(cancel, ok);
      dlg.append(h, p, row);
      document.body.appendChild(dlg);
      const done = (v) => {
        dlg.close();
        dlg.remove();
        resolve(v);
      };
      cancel.addEventListener('click', () => done(false));
      ok.addEventListener('click', () => done(true));
      dlg.addEventListener('cancel', (e) => (e.preventDefault(), done(false)));
      dlg.showModal();
      cancel.focus(); // en acciones destructivas el foco inicial va a la opción segura
    });
  }

  // Confirmación para formularios destructivos: <form data-confirm="¿Seguro?">
  document.addEventListener('submit', (ev) => {
    const form = ev.target;
    const msg = form.getAttribute('data-confirm');
    if (!msg || form.dataset.confirmed === '1') return;
    ev.preventDefault();
    confirmDialog(msg, { okLabel: ev.submitter?.textContent?.trim() || 'Confirmar' }).then((yes) => {
      if (!yes) return;
      form.dataset.confirmed = '1';
      if (form.requestSubmit) form.requestSubmit(ev.submitter || undefined);
      else form.submit();
    });
  });

  // --- Tema claro/oscuro: sistema → claro → oscuro, guardado en localStorage -----
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('[data-theme-toggle]')) return;
    const root = document.documentElement;
    const cur = root.getAttribute('data-theme');
    const next = cur === null ? 'light' : cur === 'light' ? 'dark' : null;
    if (next) root.setAttribute('data-theme', next);
    else root.removeAttribute('data-theme');
    try {
      if (next) localStorage.setItem('paas-theme', next);
      else localStorage.removeItem('paas-theme');
    } catch {
      /* sin almacenamiento: el cambio dura hasta recargar */
    }
    toast(next === 'light' ? 'Tema claro' : next === 'dark' ? 'Tema oscuro' : 'Tema del sistema', 'info');
  });

  // --- Menú lateral en móvil ---------------------------------------------------
  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-nav-toggle]');
    const sb = document.getElementById('sidebar');
    if (!sb) return;
    if (btn) {
      const open = sb.classList.toggle('open');
      btn.setAttribute('aria-expanded', String(open));
      if (open) sb.querySelector('a')?.focus();
    } else if (sb.classList.contains('open') && !ev.target.closest('#sidebar')) {
      sb.classList.remove('open');
      document.querySelector('[data-nav-toggle]')?.setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    const sb = document.getElementById('sidebar');
    if (sb?.classList.contains('open')) {
      sb.classList.remove('open');
      document.querySelector('[data-nav-toggle]')?.focus();
    }
  });

  // --- Toasts --------------------------------------------------------------------
  function dismiss(el) {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 260);
  }
  function toast(message, type = 'info') {
    let box = document.querySelector('.toasts');
    if (!box) {
      box = document.createElement('div');
      box.className = 'toasts';
      box.setAttribute('aria-live', 'polite');
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.setAttribute('role', 'status');
    const span = document.createElement('span');
    span.textContent = message;
    el.appendChild(span);
    box.appendChild(el);
    setTimeout(() => dismiss(el), 2500);
  }
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-dismiss]');
    if (b) dismiss(b.closest('[data-toast]'));
  });

  // --- Validación visible: mensaje bajo el campo inválido --------------------------
  document.addEventListener(
    'invalid',
    (ev) => {
      const field = ev.target;
      field.setAttribute('aria-invalid', 'true');
      let msg = field.parentElement.querySelector(':scope > .field-error');
      if (!msg) {
        msg = document.createElement('span');
        msg.className = 'field-error';
        msg.id = 'err-' + Math.random().toString(36).slice(2, 9);
        field.insertAdjacentElement('afterend', msg);
        field.setAttribute('aria-describedby', msg.id);
      }
      msg.textContent = field.validationMessage;
    },
    true,
  );
  document.addEventListener('input', (ev) => {
    const field = ev.target;
    if (field.getAttribute?.('aria-invalid') !== 'true' || !field.checkValidity()) return;
    field.removeAttribute('aria-invalid');
    field.parentElement.querySelector(':scope > .field-error')?.remove();
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
      toast('Copiado al portapapeles', 'success');
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
    if (!(await confirmDialog('¿Mostrar el valor en pantalla? Asegúrate de que nadie más está viendo tu pantalla.', { danger: false, okLabel: 'Mostrar' }))) return;
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

  // Plantillas del formulario "Nuevo proyecto": solo rellenan campos.
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-preset-port]');
    if (!b) return;
    const form = document.querySelector('form[action="/projects"]');
    if (!form) return;
    form.elements.port.value = b.getAttribute('data-preset-port');
    form.elements.env.value = b.getAttribute('data-preset-env');
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
    es.addEventListener('reset', () => {
      pre.textContent = '';
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
    // Los avisos de éxito/info se ocultan solos; los errores esperan a que se cierren.
    document.querySelectorAll('[data-toast]').forEach((t) => {
      if (!t.classList.contains('toast-error')) setTimeout(() => dismiss(t), 6000);
    });
    syncSource();
    syncToggles();
    document.querySelectorAll('pre[data-stream]').forEach(attachStream);
  });
})();
