import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, request, type Group, type Order, type Product, type Session } from './api';
import { telegram, useTelegram } from './telegram';
import { Empty, OrderCard, type Workspace } from './ui';
import { Catalog, ProductDetail, SelectionEditor, OrderDetail, GroupDetail } from './customer';
import { ProductEditor, SellerProducts, SellerQueue, SellerGroups } from './seller';

type Route = { kind: 'home' } | { kind: 'product'; id: string } | { kind: 'order'; id: string } | { kind: 'group'; id: string } | { kind: 'cart' } | { kind: 'edit'; order: Order } | { kind: 'product-edit'; product?: Product };
export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loginState, setLoginState] = useState('loading');
  const [loginError, setLoginError] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [sellerMode, setSellerMode] = useState(false);
  const [tab, setTab] = useState('catalog');
  const [routes, setRoutes] = useState<Route[]>([{ kind: 'home' }]);
  const [cart, setCart] = useState<Record<string, number>>({});
  const checkoutKey = useRef<{ payload: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [updated, setUpdated] = useState<Date>();
  const inFlight = useRef<Promise<void> | null>(null);
  const route = routes[routes.length - 1];
  const navigate = useCallback((next: Route) => { setRoutes(current => [...current, next]); setError(''); setNotice(''); window.scrollTo(0, 0); }, []);
  const back = useCallback(() => { setRoutes(current => current.length > 1 ? current.slice(0, -1) : current); setError(''); setNotice(''); window.scrollTo(0, 0); }, []);
  useTelegram(routes.length > 1 ? back : null);
  useEffect(() => {
    if (!telegram?.initData) { setLoginState('outside'); return; }
    request<Session>('/session', undefined, { initData: telegram.initData }).then(value => { setSession(value); setLoginState('ready'); }).catch(error => { setLoginError(error instanceof Error ? error.message : 'Unable to verify this Telegram launch.'); setLoginState('denied'); });
  }, []);
  const refresh = useCallback(async () => {
    if (!session) return;
    if (inFlight.current) return inFlight.current;
    const scope = sellerMode ? '/seller' : '';
    const work = Promise.all([
      request<Product[]>(sellerMode ? '/seller/products' : '/products', session.token),
      request<Order[]>(`${scope}/orders`, session.token),
      request<Group[]>(`${scope}/groups`, session.token)
    ]).then(([p, o, g]) => { setProducts(p); setOrders(o); setGroups(g); setUpdated(new Date()); setLoading(false); }).catch(error => {
      if (error instanceof ApiError && error.status === 401) { setSession(null); setLoginState('expired'); }
      setError(error instanceof Error ? error.message : 'Could not refresh the shop.'); setLoading(false);
      throw error;
    }).finally(() => { inFlight.current = null; });
    inFlight.current = work;
    return work;
  }, [session, sellerMode]);
  useEffect(() => {
    if (!session) return;
    let active = true;
    const update = () => { if (active && document.visibilityState === 'visible' && telegram?.isActive !== false) void refresh().catch(() => {}); };
    update();
    const interval = window.setInterval(update, 10_000);
    document.addEventListener('visibilitychange', update); window.addEventListener('online', update);
    telegram?.onEvent('activated', update);
    return () => { active = false; window.clearInterval(interval); document.removeEventListener('visibilitychange', update); window.removeEventListener('online', update); telegram?.offEvent('activated', update); };
  }, [refresh, session]);
  const run = useCallback(async (action: () => Promise<void | boolean>, success?: string) => {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try {
      if (await action() === false) return false;
      if (success) setNotice(success);
      if (inFlight.current) await inFlight.current.catch(() => {});
      await refresh().catch(() => { setError('The action finished, but the latest data could not be loaded. Refresh to see its saved result.'); });
      return true;
    }
    catch (error) {
      if (error instanceof ApiError && error.status === 401) { setSession(null); setLoginState('expired'); }
      const details = error instanceof ApiError ? error.details as { shortages?: { productId: string; requested: number; available: number }[]; productId?: string } | undefined : undefined;
      const selectionIssue = details?.shortages?.map(item => `${products.find(product => product.id === item.productId)?.name ?? 'Selected product'}: requested ${item.requested}, ${item.available} available.`).join(' ') ?? (details?.productId ? `Check ${products.find(product => product.id === details.productId)?.name ?? 'the unavailable product'} in your selection.` : '');
      setError(`${error instanceof Error ? error.message : 'Action failed.'}${selectionIssue ? ` ${selectionIssue}` : ''}${error instanceof ApiError && error.status === 409 ? ' Your selection was not silently changed. Refresh and check the current state before trying again.' : ''}`);
      if (error instanceof ApiError && error.status === 409) await refresh().catch(() => {});
      return false;
    } finally { busyRef.current = false; setBusy(false); }
  }, [refresh, products]);
  if (!session) return <main className="launch-page"><div className="brand-mark" aria-hidden="true">◇</div><span className="eyebrow">LITTLE SHOP</span><h1>{loginState === 'loading' ? 'Opening your shop…' : loginState === 'expired' ? 'Your session has ended' : loginState === 'denied' ? 'Launch could not be verified' : 'A little shop, inside Telegram'}</h1><p>{loginState === 'loading' ? 'Verifying your secure Telegram launch.' : loginState === 'outside' ? 'Open the shop from the bot’s Mini App or menu button in Telegram. Your Telegram launch is required to browse and manage purchases securely.' : loginState === 'expired' ? 'Close this Mini App and reopen it from the bot in Telegram to start a new secure session.' : loginError}</p>{loginState === 'denied' && <p>Close this window and reopen the shop from the bot in Telegram. Do not reuse an old launch link.</p>}<small>No password. No payment details shared publicly.</small></main>;
  const context: Workspace = { session, busy, run, refresh, openOrder: id => navigate({ kind: 'order', id }), openGroup: id => navigate({ kind: 'group', id }) };
  const order = route.kind === 'order' ? orders.find(value => value.id === route.id) : undefined;
  const group = route.kind === 'group' ? groups.find(value => value.id === route.id) : undefined;
  const product = route.kind === 'product' ? products.find(value => value.id === route.id) : undefined;
  const cartCount = Object.values(cart).reduce((sum, value) => sum + value, 0);
  const tabs = sellerMode ? [['products', 'Products'], ['review', 'Payments'], ['changes', 'Requests'], ['groups', 'Fulfillment']] : [['catalog', 'Shop'], ['orders', 'Orders'], ['groups', 'Delivery']];
  return <div className="app-shell"><header className="app-header"><div className="header-top"><button className="brand" onClick={() => { setRoutes([{ kind: 'home' }]); window.scrollTo(0, 0); }}><span aria-hidden="true">◇</span> Little Shop</button><div className="header-actions">{!sellerMode && <button className="cart-button" onClick={() => navigate({ kind: 'cart' })} aria-label={`Cart, ${cartCount} items`}>Cart <span>{cartCount}</span></button>}{session.user.isSeller && <button className="quiet" disabled={busy} onClick={async () => { if (inFlight.current) await inFlight.current.catch(() => {}); setSellerMode(!sellerMode); setProducts([]); setOrders([]); setGroups([]); setLoading(true); setTab(sellerMode ? 'catalog' : 'products'); setRoutes([{ kind: 'home' }]); setError(''); }}>{sellerMode ? 'Shop view' : 'Manage'}</button>}</div></div><div className="identity"><span>{sellerMode ? 'SELLER WORKSPACE' : `Hello, ${session.user.first_name}`}</span><button className="text-button" disabled={busy} onClick={() => void run(async () => {})}>Refresh</button></div>{route.kind === 'home' && <nav className="tabs" aria-label={sellerMode ? 'Management navigation' : 'Shop navigation'}>{tabs.map(([id, label]) => <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => { setTab(id); setError(''); }}>{label}{id === 'review' && orders.some(o => o.status === 'payment_review') && <span className="notification-dot" />}</button>)}</nav>}</header><main className="content">{routes.length > 1 && <button className="back-link" onClick={back}>← Back</button>}{error && <div className="notice error" role="alert"><strong>Something needs attention</strong><p>{error}</p><button onClick={() => setError('')}>Dismiss</button></div>}{notice && <div className="notice success" role="status">{notice}<button aria-label="Dismiss message" onClick={() => setNotice('')}>×</button></div>}{loading ? <div className="empty" role="status"><div className="spinner" /><h2>Loading the shop…</h2></div> : <>
      {route.kind === 'home' && !sellerMode && tab === 'catalog' && <Catalog products={products} context={context} open={id => navigate({ kind: 'product', id })} />}
      {route.kind === 'home' && !sellerMode && tab === 'orders' && <><div className="page-title"><span className="eyebrow">YOUR PURCHASES</span><h1>Orders & history</h1><p>Each order keeps its own payment and accepted prices.</p></div>{orders.length ? <div className="stack">{orders.map(o => <OrderCard key={o.id} order={o} onClick={() => context.openOrder(o.id)} />)}</div> : <Empty title="No orders yet">Browse the shop and create your first order. Adding to a cart does not reserve anything.</Empty>}</>}
      {route.kind === 'home' && tab === 'groups' && <SellerGroups groups={groups} context={context} seller={sellerMode} />}
      {route.kind === 'home' && sellerMode && tab === 'products' && <SellerProducts products={products} context={context} edit={p => navigate({ kind: 'product-edit', product: p })} />}
      {route.kind === 'home' && sellerMode && (tab === 'review' || tab === 'changes') && <SellerQueue orders={orders} context={context} requests={tab === 'changes'} />}
      {route.kind === 'product' && (product ? <ProductDetail product={product} context={context} quantity={cart[product.id] ?? 0} setQuantity={quantity => setCart(current => ({ ...current, [product.id]: quantity }))} /> : <Empty title="Product unavailable">This product is no longer visible. Return to the shop for current availability.</Empty>)}
      {route.kind === 'cart' && <SelectionEditor key="cart" products={products} groups={groups} context={context} initial={cart} checkoutKey={checkoutKey} onSelection={setCart} onDone={id => { checkoutKey.current = null; setCart({}); setRoutes([{ kind: 'home' }, { kind: 'order', id }]); }} />}
      {route.kind === 'edit' && <SelectionEditor key={route.order.id} products={products} groups={groups} context={context} order={route.order} onDone={id => setRoutes(current => [...current.slice(0, -1), { kind: 'order', id }])} />}
      {route.kind === 'order' && (order ? <OrderDetail key={order.id} order={order} products={products} context={context} seller={sellerMode} edit={() => navigate({ kind: 'edit', order })} /> : <Empty title="Order unavailable">Refresh or return to your order list.</Empty>)}
      {route.kind === 'group' && (group ? <GroupDetail key={group.id} group={group} context={context} seller={sellerMode} /> : <Empty title="Group unavailable">Refresh or return to fulfillment groups.</Empty>)}
      {route.kind === 'product-edit' && <ProductEditor key={route.product?.id ?? 'new'} product={route.product} context={context} done={back} />}
    </>}<footer className="page-footer">{updated ? `Updated ${updated.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} · Refreshes while active` : 'Secure Telegram shop'}<br />Manual payments · Thoughtfully grouped purchases</footer></main></div>;
}
