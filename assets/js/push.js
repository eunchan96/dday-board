// 마감 알림 (Web Push)
// 기기마다 브라우저 푸시 구독을 만들어 보드에 연결한다. 실제 발송은 서버(push-notify)가 10분마다 한다.

import { api } from './api.js';

// 공개 키(VAPID public key). 개인 키는 Edge Function 비밀값에만 있다.
const VAPID_PUBLIC = 'BJtAnRQJ6vP-1pfTFyPeu15elS218tZA-FSGkUqV-sWIQOJXJ3gGeXieJPb6e-WdIVF5w4AS34e6VLsRMqgyUww';

export const LEAD_OPTIONS = [[1440, '1일 전'], [180, '3시간 전'], [60, '1시간 전'], [30, '30분 전']];
export const DEFAULT_LEADS = [1440, 180];

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isEmbedded = () => { try { return window.self !== window.top; } catch { return true; } };

// 이 기기에서 알림을 켤 수 있는지
export function pushSupport() {
  if (isEmbedded()) return 'embedded';                       // 노션 임베드 안에서는 권한을 못 받음
  const has = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!has) return isIOS() && !isStandalone() ? 'ios-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return 'ok';
}

function keyBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function registration() {
  let reg = await navigator.serviceWorker.getRegistration();
  if (!reg) reg = await navigator.serviceWorker.register('sw.js');
  return navigator.serviceWorker.ready.then(() => reg);
}

async function currentSub() {
  if (pushSupport() !== 'ok') return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

// 서버 기준 상태. 이 기기 구독이 서버에 없으면(다른 보드로 옮겼다 등) 꺼진 것으로 본다.
export async function pushStatus(code) {
  const sub = await currentSub();
  if (!sub) return { subscribed: false };
  const st = await api.pushStatus(code, sub.endpoint);
  return st && st.subscribed ? st : { subscribed: false };
}

export async function enablePush(code, leads) {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied' ? 'push_denied' : 'push_dismissed');
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC) });
  return api.pushSubscribe(code, sub.toJSON(), leads);
}

export async function setLeads(code, leads) {
  const sub = await currentSub();
  if (!sub) throw new Error('not_subscribed');
  return api.pushSubscribe(code, sub.toJSON(), leads);
}

export async function disablePush(code) {
  const sub = await currentSub();
  if (!sub) return;
  try { if (code) await api.pushUnsubscribe(code, sub.endpoint); } finally { await sub.unsubscribe(); }
}

export async function testPush(code) {
  const sub = await currentSub();
  if (!sub) throw new Error('not_subscribed');
  return api.pushTest(code, sub.endpoint);
}
