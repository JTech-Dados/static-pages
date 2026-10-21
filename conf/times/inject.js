// ============================================================
// Adiciona "Times" ao menu lateral do File Browser (só admins).
// Injetado pelo NGINX (sub_filter) no HTML do /admin.
// O File Browser é uma SPA: o menu é recriado ao navegar, então
// um MutationObserver garante que o item volte a aparecer.
// ============================================================
(function () {
  "use strict";

  function isAdmin() {
    try {
      const token = localStorage.getItem("jwt");
      const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      return Boolean(payload.user && payload.user.perm && payload.user.perm.admin);
    } catch (_) {
      return false;
    }
  }

  function addItem() {
    const nav = document.querySelector("nav");
    if (!nav || nav.querySelector("[data-sp-times]") || !isAdmin()) return;

    // âncora: botão de Configurações (ícone material "settings_applications")
    const settings = Array.from(nav.querySelectorAll(".action")).find((b) =>
      /settings/.test((b.querySelector("i") || {}).textContent || ""));
    if (!settings) return;

    const link = document.createElement("a");
    link.className = "action";
    link.href = "/admin/times";
    link.dataset.spTimes = "";
    link.title = "Times";
    link.setAttribute("aria-label", "Times");

    const icon = document.createElement("i");
    icon.className = "material-icons";
    icon.textContent = "groups";
    const label = document.createElement("span");
    label.textContent = "Times";
    link.append(icon, label);

    settings.parentNode.insertBefore(link, settings);
  }

  new MutationObserver(addItem).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", addItem);
})();
