// Значения ниже ДОЛЖНЫ совпадать с tailwind.config.js → theme.extend.colors
// (base.950 / base.700 / base.800 / success.500 / error.500).
// tailwind.config.js не импортируется в рантайм-код фронтенда напрямую
// (это конфиг для сборки CSS), поэтому здесь значения продублированы как
// константы — при изменении палитры в tailwind.config.js обнови и эти.

/** base.950 — фон приложения / фон графика */
export const CHART_BG = '#23283b';

/** base.700 с прозрачностью 0.25 — линии сетки графика (было rgba(62, 72, 93, 0.25)) */
export const CHART_GRID_LINE = 'rgba(54, 69, 92, 0.25)';

/** Приглушённый сине-серый контур шкал, как у референса */
export const CHART_SCALE_BORDER = '#34415b';

/** success.500 — растущая свеча / фитиль вверх */
export const CHART_UP_COLOR = '#2ebd85';

/** error.500 — падающая свеча / фитиль вниз */
export const CHART_DOWN_COLOR = '#e5484d';
