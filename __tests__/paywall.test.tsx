import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import PaywallScreen from '../app/paywall';
import { ThemeProvider } from '../src/theme';
import * as purchasesService from '../src/services/purchases';
import { CONFIG } from '../src/domain/config';

// Mock expo-router
const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
};

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  Stack: Object.assign(() => null, { Screen: () => null }),
}));

// Mock react-native-safe-area-context
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock purchases service
jest.mock('../src/services/purchases', () => {
  const actual = jest.requireActual('../src/services/purchases');
  return {
    ...actual,
    useProStatus: jest.fn(),
    getProProductDetails: jest.fn(() => ({
      id: 'trip_photo_sorter_pro',
      title: 'Trip Photo Sorter Pro',
      price: '$4.99',
      currency: 'USD',
      benefits: [
        'Unlimited photos scanned per trip (free limit: 50 photos)',
        'Export unlimited high-resolution photos and ZIPs',
        'Batch export all people at once',
        '100% on-device & private forever',
      ],
    })),
  };
});

describe('Paywall Screen (Task 3.10)', () => {
  const mockUnlockPro = jest.fn();
  const mockRestorePurchases = jest.fn();
  const mockRefresh = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    // Default mock hook state
    (purchasesService.useProStatus as jest.Mock).mockReturnValue({
      isPro: true,
      isPurchased: false,
      isGateEnabled: false,
      isLoading: false,
      error: null,
      unlockPro: mockUnlockPro.mockResolvedValue(true),
      restorePurchases: mockRestorePurchases.mockResolvedValue(true),
      refresh: mockRefresh.mockResolvedValue(undefined),
    });
  });

  const renderScreen = async () => {
    let result: ReturnType<typeof render> | undefined;
    await act(async () => {
      result = render(
        <ThemeProvider>
          <PaywallScreen />
        </ThemeProvider>
      );
    });
    return result!;
  };

  it('renders paywall header, hero, benefits, and price card', async () => {
    const { getByTestId, getByText } = await renderScreen();

    expect(getByTestId('paywall-screen')).toBeTruthy();
    expect(getByText('Trip Photo Sorter Pro')).toBeTruthy();
    expect(getByText(/Sort, group, and share/i)).toBeTruthy();

    // Benefit items
    expect(getByTestId('benefit-unlimited-scans')).toBeTruthy();
    expect(getByTestId('benefit-full-quality')).toBeTruthy();
    expect(getByTestId('benefit-batch-export')).toBeTruthy();
    expect(getByTestId('benefit-privacy')).toBeTruthy();

    // Price card
    expect(getByTestId('paywall-pricing-card')).toBeTruthy();
    expect(getByTestId('paywall-price-text')).toBeTruthy();
    expect(getByText(CONFIG.PRO_PRICE_USD)).toBeTruthy();
    expect(getByText(/ONE-TIME PURCHASE/i)).toBeTruthy();
  });

  it('closes screen when close button (✕) is pressed', async () => {
    const { getByTestId } = await renderScreen();

    const closeButton = getByTestId('paywall-close-button');
    expect(closeButton).toBeTruthy();

    fireEvent.press(closeButton);
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  it('displays beta unlocked banner when feature flag is OFF ($0 MVP)', async () => {
    (purchasesService.useProStatus as jest.Mock).mockReturnValue({
      isPro: true,
      isPurchased: false,
      isGateEnabled: false,
      isLoading: false,
      error: null,
      unlockPro: mockUnlockPro,
      restorePurchases: mockRestorePurchases,
      refresh: mockRefresh,
    });

    const { getByTestId } = await renderScreen();
    expect(getByTestId('beta-unlocked-banner')).toBeTruthy();
  });

  it('hides beta unlocked banner when feature flag is ON', async () => {
    (purchasesService.useProStatus as jest.Mock).mockReturnValue({
      isPro: false,
      isPurchased: false,
      isGateEnabled: true,
      isLoading: false,
      error: null,
      unlockPro: mockUnlockPro,
      restorePurchases: mockRestorePurchases,
      refresh: mockRefresh,
    });

    const { queryByTestId } = await renderScreen();
    expect(queryByTestId('beta-unlocked-banner')).toBeNull();
  });

  it('shows Pro Active banner and Done button when already purchased', async () => {
    (purchasesService.useProStatus as jest.Mock).mockReturnValue({
      isPro: true,
      isPurchased: true,
      isGateEnabled: true,
      isLoading: false,
      error: null,
      unlockPro: mockUnlockPro,
      restorePurchases: mockRestorePurchases,
      refresh: mockRefresh,
    });

    const { getByTestId, queryByTestId } = await renderScreen();

    expect(getByTestId('pro-active-banner')).toBeTruthy();
    expect(getByTestId('paywall-done-button')).toBeTruthy();
    expect(queryByTestId('unlock-pro-button')).toBeNull();

    // Press Done -> calls back()
    fireEvent.press(getByTestId('paywall-done-button'));
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it('triggers unlockPro and navigates back on purchase success', async () => {
    mockUnlockPro.mockResolvedValue(true);

    const { getByTestId } = await renderScreen();
    const unlockBtn = getByTestId('unlock-pro-button');

    await act(async () => {
      fireEvent.press(unlockBtn);
    });

    expect(mockUnlockPro).toHaveBeenCalledTimes(1);

    // Feedback banner displayed
    await waitFor(() => {
      expect(getByTestId('paywall-feedback-banner')).toBeTruthy();
    });

    // Wait for auto-dismiss
    await waitFor(() => {
      expect(mockRouter.back).toHaveBeenCalled();
    });
  });

  it('handles unlockPro failure gracefully', async () => {
    mockUnlockPro.mockResolvedValue(false);

    const { getByTestId, getByText } = await renderScreen();
    const unlockBtn = getByTestId('unlock-pro-button');

    await act(async () => {
      fireEvent.press(unlockBtn);
    });

    expect(mockUnlockPro).toHaveBeenCalledTimes(1);
    expect(getByText(/Unable to complete purchase/i)).toBeTruthy();
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('handles unlockPro error throw gracefully', async () => {
    mockUnlockPro.mockRejectedValue(new Error('Network error or store unavailable'));

    const { getByTestId, getByText } = await renderScreen();
    const unlockBtn = getByTestId('unlock-pro-button');

    await act(async () => {
      fireEvent.press(unlockBtn);
    });

    expect(mockUnlockPro).toHaveBeenCalledTimes(1);
    expect(getByText(/Network error or store unavailable/i)).toBeTruthy();
  });

  it('triggers restorePurchases and auto-dismisses on successful restore', async () => {
    mockRestorePurchases.mockResolvedValue(true);

    const { getByTestId, getByText } = await renderScreen();
    const restoreBtn = getByTestId('restore-purchase-button');

    await act(async () => {
      fireEvent.press(restoreBtn);
    });

    expect(mockRestorePurchases).toHaveBeenCalledTimes(1);
    expect(getByText(/Your Pro lifetime purchase has been successfully restored/i)).toBeTruthy();

    await waitFor(() => {
      expect(mockRouter.back).toHaveBeenCalled();
    });
  });

  it('displays info notice when restorePurchases finds no previous purchase', async () => {
    mockRestorePurchases.mockResolvedValue(false);

    const { getByTestId, getByText } = await renderScreen();
    const restoreBtn = getByTestId('restore-purchase-button');

    await act(async () => {
      fireEvent.press(restoreBtn);
    });

    expect(mockRestorePurchases).toHaveBeenCalledTimes(1);
    expect(getByText(/No previous Pro purchases were found/i)).toBeTruthy();
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('handles restorePurchases error throw gracefully', async () => {
    mockRestorePurchases.mockRejectedValue(new Error('Failed to reach store server'));

    const { getByTestId, getByText } = await renderScreen();
    const restoreBtn = getByTestId('restore-purchase-button');

    await act(async () => {
      fireEvent.press(restoreBtn);
    });

    expect(mockRestorePurchases).toHaveBeenCalledTimes(1);
    expect(getByText(/Failed to reach store server/i)).toBeTruthy();
  });
});
