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

console.log('[patch-turbomodule] All patches completed.');

