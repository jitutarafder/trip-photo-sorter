import { useEffect, useState, useCallback } from 'react';
import { AppState, type AppStateStatus, Linking } from 'react-native';
import * as MediaLibrary from 'expo-media-library';

export type LibraryPermissionStatus = 'full' | 'limited' | 'denied' | 'undetermined';

export interface LibraryPermissionState {
  status: LibraryPermissionStatus;
  granted: boolean;
  canAskAgain: boolean;
  accessPrivileges?: 'all' | 'limited' | 'none';
}

export interface UseLibraryPermissionOptions {
  autoRefreshOnActive?: boolean;
}

export interface UseLibraryPermissionResult extends LibraryPermissionState {
  isLoading: boolean;
  requestPermission: () => Promise<LibraryPermissionState>;
  refreshPermission: () => Promise<LibraryPermissionState>;
  openSettings: () => Promise<void>;
  presentPicker: () => Promise<void>;
}

/**
 * Maps expo-media-library's PermissionResponse to our tri-state domain permission model:
 * 'full' | 'limited' | 'denied' (or 'undetermined' prior to user action).
 */
export function mapPermissionResponse(
  response: Pick<MediaLibrary.PermissionResponse, 'status' | 'granted' | 'canAskAgain' | 'accessPrivileges'>,
): LibraryPermissionState {
  let mappedStatus: LibraryPermissionStatus;

  if (response.accessPrivileges === 'limited') {
    mappedStatus = 'limited';
  } else if (response.accessPrivileges === 'all') {
    mappedStatus = 'full';
  } else if (response.accessPrivileges === 'none') {
    if (
      response.status === MediaLibrary.PermissionStatus.UNDETERMINED ||
      (response.status as string) === 'undetermined'
    ) {
      mappedStatus = 'undetermined';
    } else {
      mappedStatus = 'denied';
    }
  } else {
    // If accessPrivileges is undefined (e.g. Android < 14 or mock environments)
    if (
      response.status === MediaLibrary.PermissionStatus.GRANTED ||
      (response.status as string) === 'granted'
    ) {
      mappedStatus = 'full';
    } else if (
      response.status === MediaLibrary.PermissionStatus.DENIED ||
      (response.status as string) === 'denied'
    ) {
      mappedStatus = 'denied';
    } else {
      mappedStatus = 'undetermined';
    }
  }

  const isGranted = mappedStatus === 'full' || mappedStatus === 'limited';

  return {
    status: mappedStatus,
    granted: isGranted,
    canAskAgain: response.canAskAgain ?? true,
    accessPrivileges: response.accessPrivileges,
  };
}

/**
 * Get current photo library permissions (read-only, writeOnly = false).
 */
export async function getLibraryPermissionStatus(): Promise<LibraryPermissionState> {
  const response = await MediaLibrary.getPermissionsAsync(false);
  return mapPermissionResponse(response);
}

/**
 * Request photo library permissions (read-only, writeOnly = false).
 */
export async function requestLibraryPermission(): Promise<LibraryPermissionState> {
  const response = await MediaLibrary.requestPermissionsAsync(false);
  return mapPermissionResponse(response);
}

/**
 * Open device system settings for this app (e.g. when permission is denied).
 */
export async function openLibrarySettings(): Promise<void> {
  await Linking.openSettings();
}

/**
 * Open system limited photo picker dialog so user can select additional photos.
 * Only applicable when access is 'limited' (iOS 14+ / Android 14+).
 */
export async function presentLimitedLibraryPicker(): Promise<void> {
  if (typeof MediaLibrary.presentPermissionsPickerAsync === 'function') {
    await MediaLibrary.presentPermissionsPickerAsync();
  }
}

/**
 * Hook to observe and request photo library permissions.
 * Re-checks status when the app returns to the foreground (AppState 'active').
 */
export function useLibraryPermission(
  options: UseLibraryPermissionOptions = {},
): UseLibraryPermissionResult {
  const { autoRefreshOnActive = true } = options;

  const [state, setState] = useState<LibraryPermissionState>({
    status: 'undetermined',
    granted: false,
    canAskAgain: true,
    accessPrivileges: undefined,
  });
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const applyStatus = useCallback(async () => {
    try {
      const result = await getLibraryPermissionStatus();
      setState(result);
      return result;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const requestPermission = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await requestLibraryPermission();
      setState(result);
      return result;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const refreshPermission = useCallback(async () => {
    setIsLoading(true);
    return applyStatus();
  }, [applyStatus]);

  const openSettings = useCallback(async () => {
    await openLibrarySettings();
  }, []);

  const presentPicker = useCallback(async () => {
    await presentLimitedLibraryPicker();
  }, []);

  useEffect(() => {
    let isMounted = true;

    void (async () => {
      try {
        const result = await getLibraryPermissionStatus();
        if (isMounted) {
          setState(result);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    })();

    if (!autoRefreshOnActive) {
      return () => {
        isMounted = false;
      };
    }

    const subscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      if (nextState === 'active' && isMounted) {
        void (async () => {
          try {
            const result = await getLibraryPermissionStatus();
            if (isMounted) {
              setState(result);
            }
          } catch {
            // Ignore background error during state transition
          }
        })();
      }
    });

    return () => {
      isMounted = false;
      subscription?.remove?.();
    };
  }, [autoRefreshOnActive]);

  return {
    ...state,
    isLoading,
    requestPermission,
    refreshPermission,
    openSettings,
    presentPicker,
  };
}
