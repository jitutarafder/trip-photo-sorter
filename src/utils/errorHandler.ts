import { Alert } from 'react-native';

// Intercept unhandled JS errors so that in release mode React Native
// does not trigger RCTFatal (which throws an unhandled ObjC exception and abort()s the app)
if (typeof global !== 'undefined') {
  const globalErrorUtils = (global as any).ErrorUtils;
  if (globalErrorUtils) {
    const originalHandler = globalErrorUtils.getGlobalHandler?.();
    globalErrorUtils.setGlobalHandler((error: any, isFatal?: boolean) => {
      const errorMsg = error?.stack || error?.message || String(error);
      console.error('[Global Startup Error]', errorMsg);
      try {
        Alert.alert('Startup Error', errorMsg.slice(0, 400));
      } catch {
        // ignore alert errors
      }
      // Pass isFatal: false so ExceptionsManager calls reportSoftException instead of reportFatalException!
      if (originalHandler) {
        try {
          originalHandler(error, false);
        } catch {
          // ignore
        }
      }
    });
  }
}

