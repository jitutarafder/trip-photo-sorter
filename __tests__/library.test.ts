import * as React from 'react';
import { AppState, Linking, type AppStateStatus } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import {
  mapPermissionResponse,
  getLibraryPermissionStatus,
  requestLibraryPermission,
  openLibrarySettings,
  presentLimitedLibraryPicker,
  useLibraryPermission,
} from '../src/services/library';

// Mock expo-media-library
jest.mock('expo-media-library', () => {
  return {
    PermissionStatus: {
      GRANTED: 'granted',
      DENIED: 'denied',
      UNDETERMINED: 'undetermined',
    },
    getPermissionsAsync: jest.fn(),
    requestPermissionsAsync: jest.fn(),
    presentPermissionsPickerAsync: jest.fn(),
  };
});

// React 19 internals type for mocking hooks in node environment
interface ReactInternalsWithDispatcher {
  H: {
    useState?: (initial: unknown) => [unknown, (updater: unknown) => void];
    useCallback?: (fn: unknown, deps?: unknown[]) => unknown;
    useEffect?: (effect: () => (() => void) | void, deps?: unknown[]) => void;
  } | null;
}

/**
 * A lightweight, reliable hook runner for testing React hooks in Node/Jest without
 * requiring external test-renderer / DOM engines.
 */
function renderHookSim<T>(hookFn: () => T) {
  const stateSlots: unknown[] = [];
  const setterSlots: ((val: unknown) => void)[] = [];
  let slotIndex = 0;
  let effectCleanup: (() => void) | void;
  let effectFn: (() => (() => void) | void) | undefined;
  let effectDeps: unknown[] | undefined;
  let prevEffectDeps: unknown[] | undefined;

  const result: { current: T } = { current: undefined as unknown as T };

  // React 19 client internals
  const reactInternals = (React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: ReactInternalsWithDispatcher;
  }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

  const originalDispatcher = reactInternals?.H ?? null;

  const runRender = () => {
    slotIndex = 0;
    if (reactInternals) {
      reactInternals.H = dispatcherMock;
    }
    result.current = hookFn();
  };

  const runEffect = () => {
    if (effectFn) {
      if (
        !effectDeps ||
        !prevEffectDeps ||
        effectDeps.length !== prevEffectDeps.length ||
        effectDeps.some((d, i) => !Object.is(d, prevEffectDeps![i]))
      ) {
        if (typeof effectCleanup === 'function') {
          effectCleanup();
        }
        effectCleanup = effectFn();
        prevEffectDeps = effectDeps;
      }
    }
  };

  const dispatcherMock = {
    useState: (initial: unknown) => {
      const currIndex = slotIndex++;
      if (stateSlots.length <= currIndex) {
        stateSlots[currIndex] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      }
      if (!setterSlots[currIndex]) {
        setterSlots[currIndex] = (updater: unknown) => {
          stateSlots[currIndex] =
            typeof updater === 'function'
              ? (updater as (prev: unknown) => unknown)(stateSlots[currIndex])
              : updater;
          runRender();
        };
      }
      return [stateSlots[currIndex], setterSlots[currIndex]] as [unknown, (updater: unknown) => void];
    },
    useCallback: (fn: unknown) => fn,
    useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {
      effectFn = effect;
      effectDeps = deps;
    },
  };

  runRender();
  runEffect();

  return {
    result,
    unmount: () => {
      if (typeof effectCleanup === 'function') {
        effectCleanup();
      }
      if (reactInternals) {
        reactInternals.H = originalDispatcher;
      }
    },
    rerender: () => {
      runRender();
      runEffect();
    },
  };
}

describe('Photo Library Permissions Service (src/services/library.ts)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('mapPermissionResponse', () => {
    it('maps accessPrivileges: "all" to status: "full"', () => {
      const res = mapPermissionResponse({
        status: MediaLibrary.PermissionStatus.GRANTED,
        granted: true,
        canAskAgain: true,
        accessPrivileges: 'all',
      });
      expect(res.status).toBe('full');
      expect(res.granted).toBe(true);
      expect(res.canAskAgain).toBe(true);
      expect(res.accessPrivileges).toBe('all');
    });

    it('maps accessPrivileges: "limited" to status: "limited"', () => {
      const res = mapPermissionResponse({
        status: MediaLibrary.PermissionStatus.GRANTED,
        granted: true,
        canAskAgain: true,
        accessPrivileges: 'limited',
      });
      expect(res.status).toBe('limited');
      expect(res.granted).toBe(true);
      expect(res.canAskAgain).toBe(true);
      expect(res.accessPrivileges).toBe('limited');
    });

    it('maps accessPrivileges: "none" with status: "denied" to status: "denied"', () => {
      const res = mapPermissionResponse({
        status: MediaLibrary.PermissionStatus.DENIED,
        granted: false,
        canAskAgain: false,
        accessPrivileges: 'none',
      });
      expect(res.status).toBe('denied');
      expect(res.granted).toBe(false);
      expect(res.canAskAgain).toBe(false);
      expect(res.accessPrivileges).toBe('none');
    });

    it('maps accessPrivileges: "none" with status: "undetermined" to status: "undetermined"', () => {
      const res = mapPermissionResponse({
        status: MediaLibrary.PermissionStatus.UNDETERMINED,
        granted: false,
        canAskAgain: true,
        accessPrivileges: 'none',
      });
      expect(res.status).toBe('undetermined');
      expect(res.granted).toBe(false);
      expect(res.canAskAgain).toBe(true);
      expect(res.accessPrivileges).toBe('none');
    });

    it('maps status: "granted" when accessPrivileges is undefined to "full"', () => {
      const res = mapPermissionResponse({
        status: MediaLibrary.PermissionStatus.GRANTED,
        granted: true,
        canAskAgain: true,
      });
      expect(res.status).toBe('full');
      expect(res.granted).toBe(true);
    });

    it('maps status: "denied" when accessPrivileges is undefined to "denied"', () => {
      const res = mapPermissionResponse({
        status: MediaLibrary.PermissionStatus.DENIED,
        granted: false,
        canAskAgain: false,
      });
      expect(res.status).toBe('denied');
      expect(res.granted).toBe(false);
    });

    it('maps status: "undetermined" when accessPrivileges is undefined to "undetermined"', () => {
      const res = mapPermissionResponse({
        status: MediaLibrary.PermissionStatus.UNDETERMINED,
        granted: false,
        canAskAgain: true,
      });
      expect(res.status).toBe('undetermined');
      expect(res.granted).toBe(false);
    });
  });

  describe('getLibraryPermissionStatus', () => {
    it('requests current permission with writeOnly = false (read-only)', async () => {
      (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
        status: MediaLibrary.PermissionStatus.GRANTED,
        granted: true,
        canAskAgain: true,
        accessPrivileges: 'all',
      });

      const result = await getLibraryPermissionStatus();

      expect(MediaLibrary.getPermissionsAsync).toHaveBeenCalledWith(false);
      expect(result).toEqual({
        status: 'full',
        granted: true,
        canAskAgain: true,
        accessPrivileges: 'all',
      });
    });
  });

  describe('requestLibraryPermission', () => {
    it('requests user permission with writeOnly = false (read-only)', async () => {
      (MediaLibrary.requestPermissionsAsync as jest.Mock).mockResolvedValueOnce({
        status: MediaLibrary.PermissionStatus.GRANTED,
        granted: true,
        canAskAgain: true,
        accessPrivileges: 'limited',
      });

      const result = await requestLibraryPermission();

      expect(MediaLibrary.requestPermissionsAsync).toHaveBeenCalledWith(false);
      expect(result).toEqual({
        status: 'limited',
        granted: true,
        canAskAgain: true,
        accessPrivileges: 'limited',
      });
    });
  });

  describe('openLibrarySettings', () => {
    it('calls Linking.openSettings()', async () => {
      const openSettingsSpy = jest.spyOn(Linking, 'openSettings').mockResolvedValueOnce(undefined as never);

      await openLibrarySettings();

      expect(openSettingsSpy).toHaveBeenCalledTimes(1);
      openSettingsSpy.mockRestore();
    });
  });

  describe('presentLimitedLibraryPicker', () => {
    it('calls MediaLibrary.presentPermissionsPickerAsync()', async () => {
      (MediaLibrary.presentPermissionsPickerAsync as jest.Mock).mockResolvedValueOnce(undefined);

      await presentLimitedLibraryPicker();

      expect(MediaLibrary.presentPermissionsPickerAsync).toHaveBeenCalledTimes(1);
    });
  });

  describe('useLibraryPermission hook', () => {
    it('fetches initial permission status on mount', async () => {
      (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
        status: MediaLibrary.PermissionStatus.GRANTED,
        granted: true,
        canAskAgain: true,
        accessPrivileges: 'all',
      });

      const harness = renderHookSim(() => useLibraryPermission());

      expect(harness.result.current.isLoading).toBe(true);

      // Wait for asynchronous mount effect
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(harness.result.current.isLoading).toBe(false);
      expect(harness.result.current.status).toBe('full');
      expect(harness.result.current.granted).toBe(true);
      expect(harness.result.current.accessPrivileges).toBe('all');

      harness.unmount();
    });

    it('updates status when requestPermission is called', async () => {
      (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
        status: MediaLibrary.PermissionStatus.UNDETERMINED,
        granted: false,
        canAskAgain: true,
        accessPrivileges: 'none',
      });

      const harness = renderHookSim(() => useLibraryPermission());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(harness.result.current.status).toBe('undetermined');

      (MediaLibrary.requestPermissionsAsync as jest.Mock).mockResolvedValueOnce({
        status: MediaLibrary.PermissionStatus.GRANTED,
        granted: true,
        canAskAgain: true,
        accessPrivileges: 'limited',
      });

      const update = await harness.result.current.requestPermission();
      expect(update.status).toBe('limited');
      expect(harness.result.current.status).toBe('limited');
      expect(harness.result.current.granted).toBe(true);
      expect(harness.result.current.isLoading).toBe(false);

      harness.unmount();
    });

    it('updates status when refreshPermission is called', async () => {
      (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
        status: MediaLibrary.PermissionStatus.DENIED,
        granted: false,
        canAskAgain: false,
        accessPrivileges: 'none',
      });

      const harness = renderHookSim(() => useLibraryPermission());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(harness.result.current.status).toBe('denied');

      (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
        status: MediaLibrary.PermissionStatus.GRANTED,
        granted: true,
        canAskAgain: true,
        accessPrivileges: 'all',
      });

      const update = await harness.result.current.refreshPermission();
      expect(update.status).toBe('full');
      expect(harness.result.current.status).toBe('full');
      expect(harness.result.current.granted).toBe(true);

      harness.unmount();
    });

    it('re-checks permissions when AppState changes to active', async () => {
      let appStateListener: ((state: AppStateStatus) => void) | undefined;
      const removeMock = jest.fn();

      jest.spyOn(AppState, 'addEventListener').mockImplementation((event, listener) => {
        if (event === 'change') {
          appStateListener = listener as (state: AppStateStatus) => void;
        }
        return { remove: removeMock } as never;
      });

      (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
        status: MediaLibrary.PermissionStatus.DENIED,
        granted: false,
        canAskAgain: false,
        accessPrivileges: 'none',
      });

      const harness = renderHookSim(() => useLibraryPermission());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(harness.result.current.status).toBe('denied');

      // User returns from Settings (app becomes active)
      (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
        status: MediaLibrary.PermissionStatus.GRANTED,
        granted: true,
        canAskAgain: true,
        accessPrivileges: 'all',
      });

      expect(appStateListener).toBeDefined();

      appStateListener?.('active');
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(harness.result.current.status).toBe('full');

      harness.unmount();
      expect(removeMock).toHaveBeenCalledTimes(1);
    });

    it('respects autoRefreshOnActive: false', async () => {
      const addEventListenerSpy = jest.spyOn(AppState, 'addEventListener');

      (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
        status: MediaLibrary.PermissionStatus.DENIED,
        granted: false,
        canAskAgain: false,
      });

      const harness = renderHookSim(() => useLibraryPermission({ autoRefreshOnActive: false }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(harness.result.current.isLoading).toBe(false);

      expect(addEventListenerSpy).not.toHaveBeenCalled();

      harness.unmount();
      addEventListenerSpy.mockRestore();
    });

    it('provides openSettings and presentPicker helper methods', async () => {
      const openSettingsSpy = jest.spyOn(Linking, 'openSettings').mockResolvedValueOnce(undefined as never);
      (MediaLibrary.presentPermissionsPickerAsync as jest.Mock).mockResolvedValueOnce(undefined);
      (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
        status: MediaLibrary.PermissionStatus.GRANTED,
        granted: true,
        canAskAgain: true,
      });

      const harness = renderHookSim(() => useLibraryPermission());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(harness.result.current.isLoading).toBe(false);

      await harness.result.current.openSettings();
      expect(openSettingsSpy).toHaveBeenCalledTimes(1);

      await harness.result.current.presentPicker();
      expect(MediaLibrary.presentPermissionsPickerAsync).toHaveBeenCalledTimes(1);

      harness.unmount();
      openSettingsSpy.mockRestore();
    });
  });
});
