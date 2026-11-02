// @ts-nocheck
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const AnimatedView = (props: any) => React.createElement('AnimatedView', props, props.children);
const Pressable = (props: any) => React.createElement('Pressable', props, props.children);
const Text = (props: any) => React.createElement('Text', props, props.children);
const View = (props: any) => React.createElement('View', props, props.children);
const window = { width: 390, height: 844, scale: 3, fontScale: 1 };
mock.module('react-native', () => ({
  Animated: {
    Value: class { setValue() {} },
    View: AnimatedView,
    timing: () => ({ start: (done?: () => void) => done?.() }),
    parallel: () => ({ start: (done?: () => void) => done?.() }),
  },
  Easing: { cubic: 'cubic', out: (v: unknown) => v, in: (v: unknown) => v },
  Pressable,
  StyleSheet: { create: (styles: unknown) => styles },
  Text,
  View,
  useWindowDimensions: () => window,
}));
mock.module('@expo/vector-icons', () => ({ Ionicons: (props: any) => React.createElement('Ionicons', props) }));
mock.module('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 10 }) }));
mock.module('../lib/theme-context', () => ({
  useTheme: () => ({ colors: { amber: '#fc0', green: '#090', red: '#c00', ink: '#111', ink2: '#333', line: '#ddd', paper: '#fff' } }),
}));

const { default: ToastOverlay, toastDurationMs } = await import('./Toast');
let renderer: TestRenderer.ReactTestRenderer | null = null;
afterEach(() => { if (renderer) act(() => renderer!.unmount()); renderer = null; window.fontScale = 1; });

describe('actionable trash toast', () => {
  test('renders the moved count plus Undo and View Trash actions for about six seconds', () => {
    let undone = 0;
    let opened = 0;
    let dismissed = 0;
    act(() => {
      renderer = TestRenderer.create(
        <ToastOverlay
          toast={{
            id: 1,
            type: 'success',
            message: '5 items moved to Trash',
            action: { label: 'Undo', onPress: () => { undone += 1; } },
            secondaryAction: { label: 'View Trash', onPress: () => { opened += 1; } },
          }}
          onDismiss={() => { dismissed += 1; }}
        />,
      );
    });
    const overlay = renderer!.root.findByProps({ accessibilityLabel: 'success: 5 items moved to Trash' });
    const style = Object.assign({}, ...overlay.props.style.filter(Boolean));
    expect(style.flexDirection).toBe('row');
    expect(style.alignItems).toBe('center');
    expect(renderer!.root.findByProps({ children: '5 items moved to Trash' }).props.numberOfLines).toBeUndefined();
    const actions = renderer!.root.findAllByType(Pressable);
    expect(actions.map((node) => node.props.accessibilityLabel)).toEqual(['Undo', 'View Trash']);
    act(() => actions[0].props.onPress());
    expect({ undone, opened, dismissed }).toEqual({ undone: 1, opened: 0, dismissed: 1 });
    expect(toastDurationMs({ action: { label: 'Undo', onPress() {} } } as any)).toBe(6000);
  });

  test('stacks an actionable toast when the system text size is large', () => {
    window.fontScale = 1.6;
    act(() => {
      renderer = TestRenderer.create(
        <ToastOverlay
          toast={{
            id: 2,
            type: 'success',
            message: '5 items moved to Trash',
            action: { label: 'Undo', onPress() {} },
            secondaryAction: { label: 'View Trash', onPress() {} },
          }}
          onDismiss={() => {}}
        />,
      );
    });
    const overlay = renderer!.root.findByProps({ accessibilityLabel: 'success: 5 items moved to Trash' });
    const style = Object.assign({}, ...overlay.props.style.filter(Boolean));
    expect(style.flexDirection).toBe('column');
    expect(style.alignItems).toBe('stretch');
  });
});
