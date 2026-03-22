(() => {
  const PRODUCT_NAME = 'Bingo Animalito';
  // Estos archivos conservan el nombre histórico BingOnline porque se comparten intencionalmente
  // entre productos y no deben renombrarse sin una migración coordinada de branding/assets.
  const DEFAULT_LOGO = 'img/Logo-BingOnline-nuevo500p.png';
  const DECEMBER_LOGO = 'img/Logo-BingOnline-cuadrado500p-navidad.png';

  const isDecember = (date = new Date()) => date.getMonth && date.getMonth() === 11;

  const getSeasonalLogo = () => (isDecember() ? DECEMBER_LOGO : DEFAULT_LOGO);

  const replaceLogoImages = () => {
    if (!isDecember()) {
      return;
    }
    const seasonalLogo = DECEMBER_LOGO;
    if (typeof document === 'undefined') {
      return;
    }
    const images = document.querySelectorAll('img');
    images.forEach(img => {
      const src = img.getAttribute('src') || '';
      if (src.includes(DEFAULT_LOGO)) {
        img.setAttribute('src', seasonalLogo);
      }
    });
  };

  if (typeof window !== 'undefined') {
    window.PRODUCT_NAME = window.PRODUCT_NAME || PRODUCT_NAME;
    window.getSeasonalLogo = getSeasonalLogo;
    window.applySeasonalLogoImages = replaceLogoImages;
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', replaceLogoImages);
  }
})();
