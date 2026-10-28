import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { Text, View, useColorScheme } from 'react-native';
import { ThemeProvider, useTheme } from '../src/theme';
import { ErrorBoundary, ErrorFallback } from '../src/components/ErrorBoundary';

// Helper component that consumes theme
const ThemeConsumer = () => {
  const { colorScheme, isDark, colors } = useTheme();
  return (
    <View testID="theme-consumer">
      <Text testID="color-scheme">{colorScheme}</Text>
      <Text testID="is-dark">{isDark ? 'true' : 'false'}</Text>
      <Text testID="bg-color">{colors.bg}</Text>
    </View>
  );
};

// Component that throws an error for testing ErrorBoundary
const CrashComponent = ({ shouldCrash }: { shouldCrash: boolean }) => {
  if (shouldCrash) {
    throw new Error('Test crash in child component');
  }
  return <Text testID="normal-content">App running normally</Text>;
};

describe('Root Layout, Theme Provider, and Error Boundary (Task 3.2)', () => {
  describe('ThemeProvider', () => {
    it('provides dark theme when explicitly specified', async () => {
      const { getByTestId } = await render(
        <ThemeProvider colorScheme="dark">
          <ThemeConsumer />
        </ThemeProvider>
      );

      expect(getByTestId('color-scheme').props.children).toBe('dark');
      expect(getByTestId('is-dark').props.children).toBe('true');
      expect(getByTestId('bg-color').props.children).toBe('#0B0D12');
    });

    it('provides light theme when explicitly specified', async () => {
      const { getByTestId } = await render(
        <ThemeProvider colorScheme="light">
          <ThemeConsumer />
        </ThemeProvider>
      );

      expect(getByTestId('color-scheme').props.children).toBe('light');
      expect(getByTestId('is-dark').props.children).toBe('false');
      expect(getByTestId('bg-color').props.children).toBe('#F6F7FB');
    });

    it('follows system color scheme when no override is passed', async () => {
      const systemScheme = useColorScheme();
      const expectedScheme = systemScheme === 'light' ? 'light' : 'dark';

      const { getByTestId } = await render(
        <ThemeProvider>
          <ThemeConsumer />
        </ThemeProvider>
      );

      expect(getByTestId('color-scheme').props.children).toBe(expectedScheme);
    });
  });

  describe('ErrorBoundary and ErrorFallback', () => {
    // Suppress React 19 test-renderer onCaughtError console output during intentional crash tests
    const originalConsoleError = console.error;
    beforeAll(() => {
      console.error = (...args: any[]) => {
        const first = args[0];
        const str = typeof first === 'string' ? first : String(first?.message ?? first?.stack ?? '');
        if (
          str.includes('The above error occurred') ||
          str.includes('Test crash in child component') ||
          (typeof first === 'object' && first !== null && 'error' in first)
        ) {
          return;
        }
        originalConsoleError(...args);
      };
    });
    afterAll(() => {
      console.error = originalConsoleError;
    });

    it('renders normal children when no error is thrown', async () => {
      const { getByTestId } = await render(
        <ErrorBoundary>
          <CrashComponent shouldCrash={false} />
        </ErrorBoundary>
      );

      expect(getByTestId('normal-content')).toBeTruthy();
    });

    it('catches render errors and displays ErrorFallback screen', async () => {
      const onErrorMock = jest.fn();

      const { getByText, getByTestId } = await render(
        <ErrorBoundary onError={onErrorMock}>
          <CrashComponent shouldCrash={true} />
        </ErrorBoundary>
      );

      expect(getByText('Something went wrong')).toBeTruthy();
      expect(
        getByText(
          'An unexpected error occurred. Your photos and database are safe. Tap Restart to reload.'
        )
      ).toBeTruthy();
      expect(getByTestId('error-boundary-restart-btn')).toBeTruthy();
      expect(onErrorMock).toHaveBeenCalledTimes(1);
    });

    it('toggles technical details in ErrorFallback', async () => {
      const { queryByTestId, findByTestId, getAllByText, getByTestId } = await render(
        <ErrorFallback error={new Error('Specific test failure')} />
      );

      expect(queryByTestId('error-boundary-details')).toBeNull();

      const toggleBtn = getByTestId('error-boundary-toggle-details');
      fireEvent.press(toggleBtn);

      expect(await findByTestId('error-boundary-details')).toBeTruthy();
      expect(getAllByText(/Specific test failure/).length).toBeGreaterThanOrEqual(1);

      fireEvent.press(toggleBtn);
      await waitFor(() => {
        expect(queryByTestId('error-boundary-details')).toBeNull();
      });
    });

    it('calls onRestart callback and resets error state', async () => {
      const onResetMock = jest.fn();

      const { getByTestId } = await render(
        <ErrorBoundary onReset={onResetMock}>
          <CrashComponent shouldCrash={true} />
        </ErrorBoundary>
      );

      const restartBtn = getByTestId('error-boundary-restart-btn');
      fireEvent.press(restartBtn);

      expect(onResetMock).toHaveBeenCalledTimes(1);
    });

    it('supports custom fallback render prop', async () => {
      const { getByText } = await render(
        <ErrorBoundary
          fallback={({ error }) => (
            <Text testID="custom-fallback">Custom: {error.message}</Text>
          )}
        >
          <CrashComponent shouldCrash={true} />
        </ErrorBoundary>
      );

      expect(getByText('Custom: Test crash in child component')).toBeTruthy();
    });
  });
});
