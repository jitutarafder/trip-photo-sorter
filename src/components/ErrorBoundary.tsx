import React, { Component, type ReactNode } from 'react';
import { StyleSheet, View, Text, ScrollView } from 'react-native';
import { AlertTriangle } from 'lucide-react-native';
import { useTheme } from '../hooks/useTheme';
import { Button } from './ui/Button';

export interface ErrorFallbackProps {
  error: Error;
  onRestart?: () => void;
  testID?: string;
}

/**
 * Visual Error Screen Fallback (Task 3.2, 02_AppFlow §4)
 * "Unhandled JS error: Error boundary screen with Restart"
 */
export const ErrorFallback: React.FC<ErrorFallbackProps> = ({
  error,
  onRestart,
  testID = 'error-boundary',
}) => {
  const { colors, tokens } = useTheme();
  const [showDetails, setShowDetails] = React.useState(false);

  return (
    <View
      testID={testID}
      style={[
        styles.container,
        {
          backgroundColor: colors.bg,
          paddingHorizontal: tokens.spacing.screenPadding,
        },
      ]}
    >
      <View style={styles.content}>
        <View
          style={[
            styles.iconWrapper,
            {
              backgroundColor: colors.surfaceAlt,
              borderRadius: tokens.radius.pill,
            },
          ]}
        >
          <AlertTriangle size={36} color={colors.danger} strokeWidth={2} />
        </View>

        <Text
          style={[
            styles.title,
            {
              color: colors.text,
              fontSize: tokens.typography.title.fontSize,
              lineHeight: tokens.typography.title.lineHeight,
              fontWeight: tokens.typography.title.fontWeight,
            },
          ]}
        >
          Something went wrong
        </Text>

        <Text
          style={[
            styles.subtitle,
            {
              color: colors.textMuted,
              fontSize: tokens.typography.body.fontSize,
              lineHeight: tokens.typography.body.lineHeight,
            },
          ]}
        >
          An unexpected error occurred. Your photos and database are safe. Tap Restart to reload.
        </Text>

        {error?.message ? (
          <View style={styles.detailsContainer}>
            <Button
              testID={`${testID}-toggle-details`}
              title={showDetails ? 'Hide technical details' : 'Show technical details'}
              variant="ghost"
              size="sm"
              onPress={() => setShowDetails((prev) => !prev)}
            />

            {showDetails && (
              <ScrollView
                testID={`${testID}-details`}
                style={[
                  styles.detailsBox,
                  {
                    backgroundColor: colors.surfaceAlt,
                    borderColor: colors.border,
                    borderRadius: tokens.radius.md,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.errorText,
                    {
                      color: colors.danger,
                      fontSize: tokens.typography.micro.fontSize,
                    },
                  ]}
                >
                  {error.name}: {error.message}
                </Text>
                {error.stack && (
                  <Text
                    style={[
                      styles.stackText,
                      {
                        color: colors.textMuted,
                        fontSize: tokens.typography.micro.fontSize,
                      },
                    ]}
                  >
                    {error.stack}
                  </Text>
                )}
              </ScrollView>
            )}
          </View>
        ) : null}

        {onRestart && (
          <View style={styles.actionWrapper}>
            <Button
              testID={`${testID}-restart-btn`}
              title="Restart"
              variant="primary"
              size="lg"
              onPress={onRestart}
            />
          </View>
        )}
      </View>
    </View>
  );
};

export interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: (props: { error: Error; resetError: () => void }) => ReactNode;
  onReset?: () => void;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Standard React Class ErrorBoundary Component.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    this.props.onError?.(error, errorInfo);
  }

  resetError = (): void => {
    this.props.onReset?.();
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    const { hasError, error } = this.state;
    const { children, fallback } = this.props;

    if (hasError && error) {
      if (fallback) {
        return fallback({ error, resetError: this.resetError });
      }
      return <ErrorFallback error={error} onRestart={this.resetError} />;
    }

    return children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    width: '100%',
    maxWidth: 420,
    alignItems: 'center',
  },
  iconWrapper: {
    width: 72,
    height: 72,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  title: {
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    textAlign: 'center',
    marginBottom: 24,
    maxWidth: 340,
  },
  detailsContainer: {
    width: '100%',
    marginBottom: 24,
    alignItems: 'center',
  },
  toggleDetails: {
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  toggleText: {
    textDecorationLine: 'underline',
  },
  detailsBox: {
    width: '100%',
    maxHeight: 140,
    borderWidth: 1,
    padding: 12,
    marginTop: 8,
  },
  errorText: {
    fontFamily: 'Courier',
    marginBottom: 4,
  },
  stackText: {
    fontFamily: 'Courier',
  },
  actionWrapper: {
    width: '100%',
    marginTop: 8,
  },
});
