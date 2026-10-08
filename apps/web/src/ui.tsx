import { useEffect, useState, type ReactNode } from 'react';
import { ApiError, date, money, statusLabels, type Line, type Order, type Session } from './api';

export interface Workspace {
  session: Session; busy: boolean;
  run: (action: () => Promise<void | boolean>, success?: string) => Promise<boolean>;
  refresh: () => Promise<void>;
  openOrder: (id: string) => void;
  openGroup: (id: string) => void;
}
export function Primary({ children, onClick, disabled = false, busy = false }: { children: string; onClick: () => void; disabled?: boolean; busy?: boolean }) {
  return <button className="primary wide" disabled={disabled || busy} onClick={onClick}>{busy ? 'Working…' : children}</button>;
}
export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <div className="empty"><span className="empty-icon" aria-hidden="true">◇</span><h2>{title}</h2><p>{children}</p></div>;
}
export function Lines({ lines, currency }: { lines: Line[]; currency: string }) {
  return lines.length ? <ul className="line-list">{lines.map((line, index) => <li key={`${line.product_id}-${line.unit_price}-${index}`}><div><strong>{line.name}</strong><small>{line.quantity} × {money(line.unit_price, currency)}</small></div><strong>{money(line.unit_price * line.quantity, currency)}</strong></li>)}</ul> : <p className="muted">No items in this revision.</p>;
}
export function OrderCard({ order, onClick }: { order: Pick<Order, 'reference' | 'status' | 'lines' | 'total' | 'currency'> & { created_at?: string }; onClick: () => void }) {
  return <button className="card row order-card" onClick={onClick}><div><span className={`badge ${order.status}`}>{statusLabels[order.status]}</span><h3>Order {order.reference}</h3><p>{order.lines.map(line => `${line.name} × ${line.quantity}`).join(' · ') || 'No current items'}</p><small>{date(order.created_at)}</small></div><div className="align-right"><strong>{money(order.total, order.currency)}</strong><span aria-hidden="true">→</span></div></button>;
}
export function Media({ id, token, alt, publicImage = false }: { id: string; token: string; alt: string; publicImage?: boolean }) {
  const [src, setSrc] = useState<string>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (publicImage) { setSrc(`/api/public-media/${id}`); return; }
    const controller = new AbortController();
    let url: string | undefined;
    setSrc(undefined); setError('');
    fetch(`/api/media/${id}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal }).then(async response => {
      if (!response.ok) throw new ApiError(response.status, 'media_error', 'This private image could not be loaded.');
      url = URL.createObjectURL(await response.blob()); setSrc(url);
    }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Image could not be loaded.'); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [id, token, publicImage, attempt]);
  if (error) return <div className="media-error"><span>{error}</span><button onClick={() => { setError(''); setAttempt(attempt + 1); }}>Retry image</button></div>;
  return src ? <a className="image-link" href={src} target="_blank" rel="noreferrer" aria-label={`Open ${alt}`}><img loading="lazy" src={src} alt={alt} onError={() => setError('Image could not be loaded.')} /></a> : <div className="image-loading" role="status" aria-label={`Loading ${alt}`} />;
}
export function Gallery({ ids, token, name, publicImages = false }: { ids: string[]; token: string; name: string; publicImages?: boolean }) {
  const [index, setIndex] = useState(0);
  const active = Math.min(index, Math.max(ids.length - 1, 0));
  return <div className="gallery">{ids[active] && <Media id={ids[active]} token={token} alt={`${name}, image ${active + 1}`} publicImage={publicImages} />}{ids.length > 1 && <div className="gallery-controls"><button disabled={active === 0} onClick={() => setIndex(active - 1)} aria-label="Previous image">←</button><span>{active + 1} / {ids.length}</span><button disabled={active === ids.length - 1} onClick={() => setIndex(active + 1)} aria-label="Next image">→</button></div>}</div>;
}
export function Quantity({ name, value, max = 2147483647, onChange, disabled }: { name: string; value: number; max?: number; onChange: (value: number) => void; disabled?: boolean }) {
  return <div className="quantity"><button aria-label={`Remove one ${name}`} disabled={disabled || value === 0} onClick={() => onChange(value - 1)}>−</button><input aria-label={`Quantity of ${name}`} type="number" min="0" max={max} step="1" inputMode="numeric" value={value} disabled={disabled} onChange={event => { const next = Number(event.target.value); if (Number.isSafeInteger(next) && next >= 0 && (max === undefined || next <= max)) onChange(next); }} /><button aria-label={`Add one ${name}`} disabled={disabled || (max !== undefined && value >= max)} onClick={() => onChange(value + 1)}>+</button></div>;
}
