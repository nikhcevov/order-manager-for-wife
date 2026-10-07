import { useEffect } from 'react';

interface NativeButton {
  setText(text: string): void; show(): void; hide(): void; enable(): void; disable(): void;
  showProgress(leaveActive?: boolean): void; hideProgress(): void;
  onClick(callback: () => void): void; offClick(callback: () => void): void;
}
interface TelegramWebApp {
  initData: string; colorScheme: 'light' | 'dark'; themeParams: Record<string, string>;
  isActive?: boolean; viewportStableHeight?: number;
  safeAreaInset?: { top: number; bottom: number; left: number; right: number };
  contentSafeAreaInset?: { top: number; bottom: number; left: number; right: number };
  ready(): void; expand(): void;
  onEvent(name: string, handler: () => void): void; offEvent(name: string, handler: () => void): void;
  BackButton: Pick<NativeButton, 'show' | 'hide' | 'onClick' | 'offClick'>;
  MainButton: NativeButton;
}
declare global { interface Window { Telegram?: { WebApp?: TelegramWebApp } } }
export const telegram = window.Telegram?.WebApp;

export function useTelegram(back: (() => void) | null) {
  useEffect(() => {
    const update = () => {
      document.documentElement.dataset.theme = telegram?.colorScheme ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const theme = telegram?.themeParams;
      if (theme) for (const [key, value] of Object.entries(theme)) if (/^#[0-9a-f]{6}$/i.test(value)) document.documentElement.style.setProperty(`--tg-${key.replaceAll('_', '-')}`, value);
      for (const side of ['top', 'right', 'bottom', 'left'] as const) {
        const inset = (telegram?.safeAreaInset?.[side] ?? 0) + (telegram?.contentSafeAreaInset?.[side] ?? 0);
        document.documentElement.style.setProperty(`--safe-${side}`, `${inset}px`);
      }
      if (telegram?.viewportStableHeight) document.documentElement.style.setProperty('--app-height', `${telegram.viewportStableHeight}px`);
    };
    telegram?.ready(); telegram?.expand(); update();
    const events = ['themeChanged', 'viewportChanged', 'safeAreaChanged', 'contentSafeAreaChanged'];
    events.forEach(event => telegram?.onEvent(event, update));
    const preference = window.matchMedia('(prefers-color-scheme: dark)');
    preference.addEventListener('change', update);
    return () => { events.forEach(event => telegram?.offEvent(event, update)); preference.removeEventListener('change', update); };
  }, []);
  useEffect(() => {
    if (!back) { telegram?.BackButton?.hide(); return; }
    telegram?.BackButton?.show(); telegram?.BackButton?.onClick(back);
    return () => { telegram?.BackButton?.offClick(back); telegram?.BackButton?.hide(); };
  }, [back]);
}
export function useNativePrimary(label: string, action: () => void, disabled: boolean, busy: boolean) {
  useEffect(() => {
    const button = telegram?.MainButton;
    if (!button) return;
    button.setText(label); button.show(); button.onClick(action);
    disabled || busy ? button.disable() : button.enable();
    busy ? button.showProgress() : button.hideProgress();
    return () => { button.offClick(action); button.hideProgress(); button.hide(); };
  }, [label, action, disabled, busy]);
}
