import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, request, type Group, type Order, type Product, type Session } from './api';
import i18next from './i18n';
import { describeError } from './i18n/errors';
import { telegram, useTelegram } from './telegram';
import { Empty, OrderCard, type Workspace } from './ui';
import { Catalog, ProductDetail, SelectionEditor, OrderDetail, GroupDetail } from './customer';
import { ProductEditor, SellerProducts, SellerQueue, SellerGroups } from './seller';

type Route = { kind: 'home' } | { kind: 'product'; id: string } | { kind: 'order'; id: string } | { kind: 'group'; id: string } | { kind: 'cart' } | { kind: 'edit'; order: Order } | { kind: 'product-edit'; product?: Product };
export default function App() {
  const { t } = useTranslation();
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
    request<Session>('/session', undefined, { initData: telegram.initData }).then(value => { setSession(value); setLoginState('ready'); }).catch(error => { setLoginError(describeError(error, id => products.find(product => product.id === id)?.name)); setLoginState('denied'); });
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
      setError(describeError(error, id => products.find(product => product.id === id)?.name)); setLoading(false);
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
      await refresh().catch(() => { setError(t('shell.run.staleData')); });
      return true;
    }
    catch (error) {
      if (error instanceof ApiError && error.status === 401) { setSession(null); setLoginState('expired'); }
      setError(describeError(error, id => products.find(product => product.id === id)?.name));
      if (error instanceof ApiError && error.status === 409) await refresh().catch(() => {});
      return false;
    } finally { busyRef.current = false; setBusy(false); }
  }, [refresh, products, t]);
  if (!session) return <main className="launch-page"><div className="brand-mark" aria-hidden="true">◇</div><span className="eyebrow">{t('shell.launch.eyebrow')}</span><h1>{loginState === 'loading' ? t('shell.launch.loadingTitle') : loginState === 'expired' ? t('shell.launch.expiredTitle') : loginState === 'denied' ? t('shell.launch.deniedTitle') : t('shell.launch.welcomeTitle')}</h1><p>{loginState === 'loading' ? t('shell.launch.loadingBody') : loginState === 'outside' ? t('shell.launch.outsideBody') : loginState === 'expired' ? t('shell.launch.expiredBody') : loginError}</p>{loginState === 'denied' && <p>{t('shell.launch.deniedBody')}</p>}<small>{t('shell.launch.privacy')}</small></main>;
  const context: Workspace = { session, busy, run, refresh, openOrder: id => navigate({ kind: 'order', id }), openGroup: id => navigate({ kind: 'group', id }) };
  const order = route.kind === 'order' ? orders.find(value => value.id === route.id) : undefined;
  const group = route.kind === 'group' ? groups.find(value => value.id === route.id) : undefined;
  const product = route.kind === 'product' ? products.find(value => value.id === route.id) : undefined;
  const cartCount = Object.values(cart).reduce((sum, value) => sum + value, 0);
  const tabs = sellerMode ? [['products', t('shell.tabs.products')], ['review', t('shell.tabs.review')], ['changes', t('shell.tabs.changes')], ['groups', t('shell.tabs.shipments')]] : [['catalog', t('shell.tabs.catalog')], ['orders', t('shell.tabs.orders')], ['groups', t('shell.tabs.packages')]];
  return <div className="app-shell"><header className="app-header"><div className="header-top"><button className="brand" onClick={() => { setRoutes([{ kind: 'home' }]); window.scrollTo(0, 0); }}><span aria-hidden="true">◇</span> Little Shop</button><div className="header-actions">{!sellerMode && <button className="cart-button" onClick={() => navigate({ kind: 'cart' })} aria-label={t('shell.header.cartLabel', { count: cartCount })}>{t('shell.header.cart')} <span>{cartCount}</span></button>}{session.user.isSeller && <button className="quiet" disabled={busy} onClick={async () => { if (inFlight.current) await inFlight.current.catch(() => {}); setSellerMode(!sellerMode); setProducts([]); setOrders([]); setGroups([]); setLoading(true); setTab(sellerMode ? 'catalog' : 'products'); setRoutes([{ kind: 'home' }]); setError(''); }}>{sellerMode ? t('shell.header.shopView') : t('shell.header.manage')}</button>}</div></div><div className="identity"><span>{sellerMode ? t('shell.header.sellerWorkspace') : t('shell.header.hello', { name: session.user.first_name })}</span><button className="text-button" disabled={busy} onClick={() => void run(async () => {})}>{t('shell.header.refresh')}</button></div>{route.kind === 'home' && <nav className="tabs" aria-label={sellerMode ? t('shell.header.managementNavigation') : t('shell.header.shopNavigation')}>{tabs.map(([id, label]) => <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => { setTab(id); setError(''); }}>{label}{id === 'review' && orders.some(o => o.status === 'payment_review') && <span className="notification-dot" />}</button>)}</nav>}</header><main className="content">{routes.length > 1 && <button className="back-link" onClick={back}>{t('shell.back')}</button>}{error && <div className="notice error" role="alert"><strong>{t('shell.notice.errorTitle')}</strong><p>{error}</p><button onClick={() => setError('')}>{t('shell.notice.dismiss')}</button></div>}{notice && <div className="notice success" role="status">{notice}<button aria-label={t('shell.notice.dismissMessage')} onClick={() => setNotice('')}>×</button></div>}{loading ? <div className="empty" role="status"><div className="spinner" /><h2>{t('shell.loading')}</h2></div> : <>
      {route.kind === 'home' && !sellerMode && tab === 'catalog' && <Catalog products={products} context={context} open={id => navigate({ kind: 'product', id })} />}
      {route.kind === 'home' && !sellerMode && tab === 'orders' && <><div className="page-title"><span className="eyebrow">{t('shell.pages.ordersEyebrow')}</span><h1>{t('shell.pages.ordersTitle')}</h1><p>{t('shell.pages.ordersBody')}</p></div>{orders.length ? <div className="stack">{orders.map(o => <OrderCard key={o.id} order={o} onClick={() => context.openOrder(o.id)} />)}</div> : <Empty title={t('shell.pages.ordersEmpty')}>{t('shell.pages.ordersEmptyBody')}</Empty>}</>}
      {route.kind === 'home' && tab === 'groups' && <SellerGroups groups={groups} context={context} seller={sellerMode} />}
      {route.kind === 'home' && sellerMode && tab === 'products' && <SellerProducts products={products} context={context} edit={p => navigate({ kind: 'product-edit', product: p })} />}
      {route.kind === 'home' && sellerMode && (tab === 'review' || tab === 'changes') && <SellerQueue orders={orders} context={context} requests={tab === 'changes'} />}
      {route.kind === 'product' && (product ? <ProductDetail product={product} context={context} quantity={cart[product.id] ?? 0} setQuantity={quantity => setCart(current => ({ ...current, [product.id]: quantity }))} /> : <Empty title={t('shell.pages.productEmpty')}>{t('shell.pages.productEmptyBody')}</Empty>)}
      {route.kind === 'cart' && <SelectionEditor key="cart" products={products} context={context} initial={cart} checkoutKey={checkoutKey} onSelection={setCart} onDone={id => { checkoutKey.current = null; setCart({}); setRoutes([{ kind: 'home' }, { kind: 'order', id }]); }} />}
      {route.kind === 'edit' && <SelectionEditor key={route.order.id} products={products} context={context} order={route.order} onDone={id => setRoutes(current => [...current.slice(0, -1), { kind: 'order', id }])} />}
      {route.kind === 'order' && (order ? <OrderDetail key={order.id} order={order} products={products} context={context} seller={sellerMode} edit={() => navigate({ kind: 'edit', order })} /> : <Empty title={t('shell.pages.orderEmpty')}>{t('shell.pages.orderEmptyBody')}</Empty>)}
      {route.kind === 'group' && (group ? <GroupDetail key={group.id} group={group} context={context} seller={sellerMode} /> : <Empty title={t('shell.pages.packageEmpty')}>{t('shell.pages.packageEmptyBody')}</Empty>)}
      {route.kind === 'product-edit' && <ProductEditor key={route.product?.id ?? 'new'} product={route.product} context={context} done={back} />}
    </>}<footer className="page-footer">{updated ? t('shell.footer.updated', { time: new Intl.DateTimeFormat(i18next.resolvedLanguage ?? 'en', { hour: '2-digit', minute: '2-digit' }).format(updated) }) : t('shell.footer.secure')}<br />{t('shell.footer.payments')}</footer></main></div>;
}
