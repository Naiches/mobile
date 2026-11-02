// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig.
/**
 * Delete-account screen state machine: the 2FA field only for 2FA accounts,
 * the "Check your email" state after a successful request (never "deleted"),
 * Resend, and the error states. Same module-mocking convention as
 * TwoFactorSetupScreen.alerts.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const Pass = (props: any) => React.createElement(React.Fragment, null, props.children);
const View = Pass;
const Text = Pass;
const TextInput = (_p: any) => null;
const TouchableOpacity = Pass;
const ScrollView = Pass;
const ActivityIndicator = (_p: any) => null;
const alertCalls: unknown[][] = [];

mock.module('react-native', () => ({
  View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator,
  StyleSheet: { create: (s: unknown) => s },
  Alert: { alert: (...a: unknown[]) => { alertCalls.push(a); } },
  Platform: { OS: 'ios' },
  useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1, scale: 3 }),
}));
mock.module('@expo/vector-icons', () => ({ Ionicons: () => null }));

let goBackCalls = 0;
mock.module('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: () => { goBackCalls += 1; } }),
}));
mock.module('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
mock.module('../lib/theme-context', () => ({
  useTheme: () => ({
    resolved: 'light',
    colors: new Proxy({}, { get: () => '#000' }),
  }),
}));
mock.module('../theme', () => ({
  radii: { md: 8 },
  spacing: { md: 12, lg: 16 },
}));

let totpEnabled = false;
let signOutCalls = 0;
mock.module('../lib/auth', () => ({
  useAuth: () => ({
    user: { user_id: 'u1', email: 'alice@example.com', totp_enabled: totpEnabled },
    signOut: async () => { signOutCalls += 1; },
  }),
}));

class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const requestCalls: Array<[string, string | undefined]> = [];
let requestImpl: (t: string, c?: string) => Promise<{ status: 'email_sent' }> = async () => ({ status: 'email_sent' });
mock.module('../lib/api', () => ({
  requestAccountDeletion: (t: string, c?: string) => { requestCalls.push([t, c]); return requestImpl(t, c); },
  friendlyError: (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.'),
  ApiError,
}));

let confirmCalls = 0;
let confirmImpl: () => Promise<string | null> = async () => 'step-up-token';
mock.module('../lib/confirm-action', () => ({
  requestConfirmation: () => { confirmCalls += 1; return confirmImpl(); },
}));
mock.module('../lib/account-cleanup', () => ({
  purgeAllPlaintextCaches: async () => {},
  purgeThenSignOut: async () => {},
}));

const { default: DeleteAccountScreen } = await import('./DeleteAccountScreen');

const byId = (root: any, id: string) =>
  root.findAll((n: any) => (n.type === TouchableOpacity || n.type === TextInput) && n.props?.testID === id);
const allText = (root: any) =>
  root.findAll((n: any) => n.type === Text).map((n: any) => [].concat(n.props.children ?? []).join('')).join(' | ');
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

let renderer: any = null;
function mount() {
  act(() => { renderer = TestRenderer.create(React.createElement(DeleteAccountScreen)); });
  return renderer.root;
}
function fillBasics(root: any) {
  act(() => { byId(root, 'delete-account-confirmation-input')[0].props.onChangeText('DELETE'); });
  act(() => { byId(root, 'delete-account-understood-checkbox')[0].props.onPress(); });
}
async function submit(root: any) {
  await act(async () => { byId(root, 'delete-account-submit')[0].props.onPress(); await flush(); });
}

beforeEach(() => {
  totpEnabled = false;
  requestCalls.length = 0;
  alertCalls.length = 0;
  confirmCalls = 0;
  goBackCalls = 0;
  signOutCalls = 0;
  confirmImpl = async () => 'step-up-token';
  requestImpl = async () => ({ status: 'email_sent' });
});
afterEach(() => {
  if (renderer) { act(() => { renderer.unmount(); }); renderer = null; }
});

describe('DeleteAccountScreen', () => {
  test('no 2FA field for an account without 2FA', () => {
    const root = mount();
    expect(byId(root, 'delete-account-totp-input')).toHaveLength(0);
  });

  test('2FA account: field shown, and submit stays off until a code is typed', () => {
    totpEnabled = true;
    const root = mount();
    fillBasics(root);
    expect(byId(root, 'delete-account-totp-input')).toHaveLength(1);
    expect(byId(root, 'delete-account-submit')[0].props.disabled).toBe(true);
    act(() => { byId(root, 'delete-account-totp-input')[0].props.onChangeText('123456'); });
    expect(byId(root, 'delete-account-submit')[0].props.disabled).toBe(false);
  });

  test('typing DELETE and ticking the box is still required', () => {
    const root = mount();
    expect(byId(root, 'delete-account-submit')[0].props.disabled).toBe(true);
    fillBasics(root);
    expect(byId(root, 'delete-account-submit')[0].props.disabled).toBe(false);
  });

  test('success shows Check your email with the masked address, never "deleted", and does not sign out', async () => {
    const root = mount();
    fillBasics(root);
    await submit(root);
    expect(requestCalls).toEqual([['step-up-token', undefined]]);
    const text = allText(renderer.root);
    expect(text).toContain('Check your email');
    expect(text).toContain('a***@example.com');
    expect(text).toContain('1 hour');
    expect(text.toLowerCase()).not.toContain('account deleted');
    expect(text.toLowerCase()).not.toContain('has been permanently deleted');
    expect(alertCalls).toHaveLength(0);
    expect(signOutCalls).toBe(0);
  });

  test('the 2FA code is sent with the request', async () => {
    totpEnabled = true;
    const root = mount();
    fillBasics(root);
    act(() => { byId(root, 'delete-account-totp-input')[0].props.onChangeText(' 123456 '); });
    await submit(root);
    expect(requestCalls).toEqual([['step-up-token', '123456']]);
  });

  test('a server code-required response reveals and requires the field even when cached 2FA is false', async () => {
    let attempts = 0;
    requestImpl = async (_token, code) => {
      attempts += 1;
      if (attempts === 1) throw new ApiError(400, 'code required', 'totp_code_required');
      expect(code).toBe('654321');
      return { status: 'email_sent' };
    };
    const root = mount();
    fillBasics(root);
    await submit(root);

    expect(byId(renderer.root, 'delete-account-totp-input')).toHaveLength(1);
    expect(byId(renderer.root, 'delete-account-submit')[0].props.disabled).toBe(true);
    act(() => { byId(renderer.root, 'delete-account-totp-input')[0].props.onChangeText('654321'); });
    expect(byId(renderer.root, 'delete-account-submit')[0].props.disabled).toBe(false);
    await submit(renderer.root);
    expect(requestCalls).toEqual([
      ['step-up-token', undefined],
      ['step-up-token', '654321'],
    ]);
  });

  test('a cancelled password prompt sends nothing', async () => {
    confirmImpl = async () => null;
    const root = mount();
    fillBasics(root);
    await submit(root);
    expect(requestCalls).toHaveLength(0);
    expect(allText(renderer.root)).not.toContain('Check your email');
  });

  test('Resend asks for the password again and sends a second request', async () => {
    const root = mount();
    fillBasics(root);
    await submit(root);
    expect(confirmCalls).toBe(1);
    await act(async () => { byId(renderer.root, 'delete-account-resend')[0].props.onPress(); await flush(); });
    expect(confirmCalls).toBe(2);
    expect(requestCalls).toHaveLength(2);
    expect(allText(renderer.root)).toContain('Check your email');
  });

  test('2FA resend needs a fresh code (the old one is single use) and clears it after sending', async () => {
    totpEnabled = true;
    const root = mount();
    fillBasics(root);
    act(() => { byId(root, 'delete-account-totp-input')[0].props.onChangeText('111111'); });
    await submit(root);
    const field = byId(renderer.root, 'delete-account-totp-input');
    expect(field).toHaveLength(1);
    expect(field[0].props.value).toBe('');
    expect(byId(renderer.root, 'delete-account-resend')[0].props.disabled).toBe(true);
    act(() => { field[0].props.onChangeText('222222'); });
    await act(async () => { byId(renderer.root, 'delete-account-resend')[0].props.onPress(); await flush(); });
    expect(requestCalls.map((c) => c[1])).toEqual(['111111', '222222']);
  });

  test('a wrong 2FA code keeps the form and says so; nothing is shown as sent', async () => {
    totpEnabled = true;
    requestImpl = async () => { throw new ApiError(400, 'bad'); };
    const root = mount();
    fillBasics(root);
    act(() => { byId(root, 'delete-account-totp-input')[0].props.onChangeText('000000'); });
    await submit(root);
    const text = allText(renderer.root);
    expect(text).toContain('did not match');
    expect(text).not.toContain('Check your email');
    expect(signOutCalls).toBe(0);
  });

  test('a server without the new endpoint shows the update message and never calls anything else', async () => {
    requestImpl = async () => { throw new ApiError(404, 'Not Found'); };
    const root = mount();
    fillBasics(root);
    await submit(root);
    const text = allText(renderer.root);
    expect(text).toContain('needs an app or server update');
    expect(text).not.toContain('Check your email');
    expect(requestCalls).toHaveLength(1);
  });

  test('a 409 deletion_needs_email_confirmation is shown as Check your email', async () => {
    requestImpl = async () => { throw new ApiError(409, 'x', 'deletion_needs_email_confirmation'); };
    const root = mount();
    fillBasics(root);
    await submit(root);
    expect(allText(renderer.root)).toContain('Check your email');
  });

  test('other failures show the friendly message and keep the form', async () => {
    requestImpl = async () => { throw new ApiError(502, 'mail down'); };
    const root = mount();
    fillBasics(root);
    await submit(root);
    expect(allText(renderer.root)).toContain('mail down');
    expect(byId(renderer.root, 'delete-account-submit')).toHaveLength(1);
  });
});
