/* global __dirname */
const fs = require('fs');
const path = require('path');

const targetFile = path.join(
  __dirname,
  '..',
  'node_modules',
  'react-native',
  'ReactCommon',
  'react',
  'nativemodule',
  'core',
  'platform',
  'ios',
  'ReactCommon',
  'RCTTurboModule.mm'
);

if (!fs.existsSync(targetFile)) {
  console.log('[patch-turbomodule] Target file not found, skipping patch.');
  process.exit(0);
}

let content = fs.readFileSync(targetFile, 'utf8');

const targetVoidPattern = `@try {
      [inv invokeWithTarget:strongModule];
    } @catch (NSException *exception) {
      throw convertNSExceptionToJSError(runtime, exception, std::string{moduleName}, methodNameStr);
    } @finally {`;

const replacementVoidPattern = `@try {
      [inv invokeWithTarget:strongModule];
    } @catch (NSException *exception) {
      NSLog(@"[TURBOMODULE CRASH PREVENTED] Module: %s, Method: %s, Name: %@, Reason: %@",
            moduleName, methodName, exception.name, exception.reason);
      if (shouldVoidMethodsExecuteSync_) {
        throw convertNSExceptionToJSError(runtime, exception, std::string{moduleName}, methodNameStr);
      }
    } @finally {`;

if (content.includes(targetVoidPattern)) {
  content = content.replace(targetVoidPattern, replacementVoidPattern);
  console.log('[patch-turbomodule] Successfully patched performVoidMethodInvocation.');
} else {
  console.log('[patch-turbomodule] performVoidMethodInvocation already patched or pattern not found.');
}

const targetAsyncPattern = `} else {
        @throw exception;
      }`;

const replacementAsyncPattern = `} else {
        NSLog(@"[TURBOMODULE ASYNC EXCEPTION PREVENTED] Module: %s, Method: %s, Name: %@, Reason: %@",
              moduleName, methodName, exception.name, exception.reason);
      }`;

if (content.includes(targetAsyncPattern)) {
  content = content.replace(targetAsyncPattern, replacementAsyncPattern);
  console.log('[patch-turbomodule] Successfully patched performMethodInvocation async throw.');
} else {
  console.log('[patch-turbomodule] performMethodInvocation already patched or pattern not found.');
}

fs.writeFileSync(targetFile, content, 'utf8');
console.log('[patch-turbomodule] Done patching RCTTurboModule.mm.');

// Patch 2: react-native-nitro-modules NativeNitroModules+NewArch.mm null CallInvoker crash
const nitroFile = path.join(
  __dirname,
  '..',
  'node_modules',
  'react-native-nitro-modules',
  'ios',
  'turbomodule',
  'NativeNitroModules+NewArch.mm'
);

if (fs.existsSync(nitroFile)) {
  let nitroContent = fs.readFileSync(nitroFile, 'utf8');
  const nitroThrowPattern = `if (callInvoker == nullptr) {
    throw std::runtime_error("Cannot install \`global.NitroModulesProxy\` - CallInvoker was null!");
  }`;
  const nitroSafePattern = `if (callInvoker == nullptr) {
    nitro::Logger::log(nitro::LogLevel::Error, "NitroModules", "CallInvoker was null - deferred installation");
    _errorMessage = @"Cannot install \`global.NitroModulesProxy\` - CallInvoker was null!";
    _didInstall = false;
    return;
  }`;

  if (nitroContent.includes(nitroThrowPattern)) {
    nitroContent = nitroContent.replace(nitroThrowPattern, nitroSafePattern);
    fs.writeFileSync(nitroFile, nitroContent, 'utf8');
    console.log('[patch-turbomodule] Successfully patched NativeNitroModules null CallInvoker crash.');
  } else {
    console.log('[patch-turbomodule] NativeNitroModules already patched or pattern not found.');
  }
}

// Patch 3: expo-splash-screen SplashScreenManager.swift NewArch loadingView freeze
const splashManagerFile = path.join(
  __dirname,
  '..',
  'node_modules',
  'expo-splash-screen',
  'ios',
  'SplashScreenManager.swift'
);

if (fs.existsSync(splashManagerFile)) {
  let splashContent = fs.readFileSync(splashManagerFile, 'utf8');

  // 1. In showSplashScreen: don't let RCTSurfaceHostingProxyRootView take ownership of loadingView, add as subview directly + add 2.0s fail-safe
  const oldShowPattern = `#if RCT_NEW_ARCH_ENABLED
      if let hostView = rootView as? RCTSurfaceHostingProxyRootView, let loadingView {
        hostView.disableActivityIndicatorAutoHide(true)
        hostView.loadingView = loadingView
      }
#else
      if let loadingView {
        self.rootView?.addSubview(loadingView)
      }
#endif`;

  const newShowPattern = `      if let loadingView {
        self.rootView?.addSubview(loadingView)
      }
      // Fail-safe: dismiss after 2.0 seconds regardless of JS callbacks
      DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
        self?.hide()
      }`;

  if (splashContent.includes(oldShowPattern)) {
    splashContent = splashContent.replace(oldShowPattern, newShowPattern);
    console.log('[patch-turbomodule] Successfully patched SplashScreenManager.swift showSplashScreen.');
  } else {
    console.log('[patch-turbomodule] SplashScreenManager.swift showSplashScreen already patched or pattern not found.');
  }

  // 2. In hide(): ensure hostView clears loadingView and auto-hide is disabled
  const oldHidePattern = `    DispatchQueue.main.async { [weak self] in
      guard let self, let rootView, isLoadingViewVisible() else {
        return
      }`;

  const newHidePattern = `    DispatchQueue.main.async { [weak self] in
      guard let self, let rootView else {
        return
      }
#if RCT_NEW_ARCH_ENABLED
      if let hostView = self.rootView as? RCTSurfaceHostingProxyRootView {
        hostView.disableActivityIndicatorAutoHide(false)
        hostView.loadingView = nil
      }
#endif
      guard self.isLoadingViewVisible() else {
        return
      }`;

  if (splashContent.includes(oldHidePattern)) {
    splashContent = splashContent.replace(oldHidePattern, newHidePattern);
    console.log('[patch-turbomodule] Successfully patched SplashScreenManager.swift hide.');
  } else {
    console.log('[patch-turbomodule] SplashScreenManager.swift hide already patched or pattern not found.');
  }

  fs.writeFileSync(splashManagerFile, splashContent, 'utf8');
}

console.log('[patch-turbomodule] All patches completed.');

