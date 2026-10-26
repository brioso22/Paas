// Se carga en <head> sin defer para aplicar el tema guardado antes de pintar (evita el parpadeo).
(function () {
  try {
    var t = localStorage.getItem('paas-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    /* almacenamiento bloqueado: se usa el tema del sistema */
  }
})();
