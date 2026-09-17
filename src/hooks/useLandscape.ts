import { useEffect, useState } from 'react';

/**
 * Detects whether the device is in landscape orientation on a mobile/narrow screen.
 * On desktop (width >= 1024px) this always returns false — the lg: layout handles those.
 */
export function useLandscape(): boolean {
  const [isLandscape, setIsLandscape] = useState(false);

  useEffect(() => {
    const check = () => {
      const narrow = window.innerWidth < 1024;
      const landscape =
        window.innerWidth > window.innerHeight ||
        (window.screen?.orientation?.type?.startsWith('landscape') ?? false);
      setIsLandscape(narrow && landscape);
    };

    check();
    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', check);
    if (window.screen?.orientation) {
      window.screen.orientation.addEventListener('change', check);
    }

    return () => {
      window.removeEventListener('resize', check);
      window.removeEventListener('orientationchange', check);
      if (window.screen?.orientation) {
        window.screen.orientation.removeEventListener('change', check);
      }
    };
  }, []);

  return isLandscape;
}
