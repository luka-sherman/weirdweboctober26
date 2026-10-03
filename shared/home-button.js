// Injects the "weird web october" top-left button that links back to the
// root calendar. Include with a single tag from any day page:
//   <script src="../shared/home-button.js"></script>
(function () {
  function addFontLink() {
    if (document.querySelector("link[data-weird-web-font]")) return;
    const preconnect1 = document.createElement("link");
    preconnect1.rel = "preconnect";
    preconnect1.href = "https://fonts.googleapis.com";
    const preconnect2 = document.createElement("link");
    preconnect2.rel = "preconnect";
    preconnect2.href = "https://fonts.gstatic.com";
    preconnect2.crossOrigin = "anonymous";
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = "https://fonts.googleapis.com/css2?family=Creepster&display=swap";
    stylesheet.setAttribute("data-weird-web-font", "");
    document.head.append(preconnect1, preconnect2, stylesheet);
  }

  function addStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .weird-web-home {
        position: fixed;
        top: 1rem;
        left: 1rem;
        font-family: "Creepster", cursive;
        font-size: clamp(1rem, 2.5vw, 1.4rem);
        color: #eee;
        text-decoration: none;
        letter-spacing: 0.02em;
        z-index: 1000;
        opacity: 0.85;
        transition: opacity 0.15s ease, color 0.15s ease;
      }
      .weird-web-home:hover { opacity: 1; color: #ff8a3d; }
    `;
    document.head.appendChild(style);
  }

  function addButton() {
    const link = document.createElement("a");
    link.className = "weird-web-home";
    link.href = "../";
    link.textContent = "weird web october";
    document.body.prepend(link);
  }

  function init() {
    addFontLink();
    addStyles();
    addButton();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
