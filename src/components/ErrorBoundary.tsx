import React from 'react';
import {
  Appearance,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { colors, darkColors, radii, spacing } from '../theme';

interface State {
  hasError: boolean;
  error: Error | null;
}

interface Props {
  children: React.ReactNode;
}

function ErrorFallback({ message, stack, onRestart }: {
  message: string;
  stack: string;
  onRestart: () => void;
}) {
  const { fontScale } = useWindowDimensions();
  const accessibilityLayout = fontScale >= 1.3;
  const logoSize = accessibilityLayout ? Math.ceil(44 * fontScale) : 44;

  // ErrorBoundary sits above ThemeProvider, so the context is unavailable.
  // Explicit theme preferences are mirrored into Appearance by theme-context.
  const c = Appearance.getColorScheme() === 'dark' ? darkColors : colors;

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: c.paper2 }]}
      contentContainerStyle={[
        styles.rootContent,
        accessibilityLayout && styles.rootContentAccessibility,
      ]}
    >
      <View style={[styles.card, { backgroundColor: c.paper, borderColor: c.line }]}>
        <View
          style={[
            styles.logo,
            { width: logoSize, height: logoSize, backgroundColor: c.ink },
          ]}
        >
          <Text style={[styles.logoText, { color: c.amber }]}>bb</Text>
        </View>

        <Text style={[styles.heading, { color: c.ink }]}>Something went wrong</Text>
        <Text style={[styles.subheading, { color: c.ink3 }]}>
          An unexpected error occurred. Tap Restart to try again.
        </Text>

        <View style={[styles.errorBox, { backgroundColor: c.paper2, borderColor: c.line }]}>
          <Text style={[styles.errorMessage, { color: c.red }]}>{message}</Text>
          {!!stack && (
            <Text
              style={[styles.errorStack, { color: c.ink3 }]}
              numberOfLines={accessibilityLayout ? undefined : 8}
            >
              {stack}
            </Text>
          )}
        </View>

        <TouchableOpacity
          style={[styles.restartButton, { backgroundColor: c.amber }]}
          onPress={onRestart}
          activeOpacity={0.8}
        >
          <Text style={[styles.restartButtonText, { color: c.ink }]}>Restart</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

export default class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  handleRestart = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const message = this.state.error?.message ?? 'Unknown error';
    const stack = this.state.error?.stack ?? '';

    return (
      <ErrorFallback message={message} stack={stack} onRestart={this.handleRestart} />
    );
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.paper2,
  },
  rootContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  rootContentAccessibility: {
    justifyContent: 'flex-start',
  },
  card: {
    width: '100%',
    backgroundColor: colors.paper,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 24,
    alignItems: 'center',
    gap: 12,
  },
  logo: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  logoText: {
    color: colors.amber,
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  heading: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.ink,
    letterSpacing: -0.2,
    textAlign: 'center',
  },
  subheading: {
    fontSize: 13,
    color: colors.ink3,
    textAlign: 'center',
    lineHeight: 18,
  },
  errorBox: {
    width: '100%',
    backgroundColor: colors.paper2,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 12,
    gap: 6,
  },
  errorMessage: {
    fontFamily: 'Courier',
    fontSize: 12,
    color: colors.red,
    lineHeight: 17,
  },
  errorStack: {
    fontFamily: 'Courier',
    fontSize: 9,
    color: colors.ink3,
    lineHeight: 14,
  },
  restartButton: {
    width: '100%',
    backgroundColor: colors.amber,
    borderRadius: radii.md,
    paddingVertical: 13,
    minHeight: 44,
    alignItems: 'center',
    marginTop: 4,
  },
  restartButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.ink,
  },
});
