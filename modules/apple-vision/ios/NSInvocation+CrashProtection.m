#import <Foundation/Foundation.h>
#import <objc/runtime.h>

/**
 * TurboModuleCrashProtection
 *
 * Intercepts uncaught NSExceptions inside NSInvocation's invoke and invokeWithTarget:.
 * React Native's ObjCTurboModule::performVoidMethodInvocation dispatches async void
 * method invocations onto a GCD queue without a C++ catch handler. If an invoked
 * Objective-C method throws an NSException, React Native catches it and rethrows a C++
 * exception into GCD, which immediately triggers std::terminate() and abort() (SIGABRT).
 *
 * By catching the NSException inside invokeWithTarget:, the exception does not escape,
 * preventing the fatal C++ rethrow and keeping the app running smoothly.
 */

@interface TurboModuleCrashGuard : NSObject
+ (void)install;
@end

@implementation TurboModuleCrashGuard
+ (void)install {
    // Calling this forces dyld and the static linker to retain this translation unit.
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        NSLog(@"[TurboModuleCrashGuard] Crash protection initialized.");
    });
}
@end

@implementation NSInvocation (TurboModuleCrashProtection)

+ (void)load {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        Class cls = [NSInvocation class];

        SEL originalWithTarget = @selector(invokeWithTarget:);
        SEL swizzledWithTarget = @selector(safe_invokeWithTarget:);
        Method origMethod1 = class_getInstanceMethod(cls, originalWithTarget);
        Method swizMethod1 = class_getInstanceMethod(cls, swizzledWithTarget);
        if (origMethod1 && swizMethod1) {
            method_exchangeImplementations(origMethod1, swizMethod1);
        }

        SEL originalInvoke = @selector(invoke);
        SEL swizzledInvoke = @selector(safe_invoke);
        Method origMethod2 = class_getInstanceMethod(cls, originalInvoke);
        Method swizMethod2 = class_getInstanceMethod(cls, swizzledInvoke);
        if (origMethod2 && swizMethod2) {
            method_exchangeImplementations(origMethod2, swizMethod2);
        }

        NSLog(@"[TurboModuleCrashGuard] NSInvocation swizzled successfully.");
    });
}

- (void)safe_invokeWithTarget:(id)target {
    @try {
        [self safe_invokeWithTarget:target];
    } @catch (NSException *exception) {
        NSLog(@"[TURBOMODULE CRASH PREVENTED] Target: %@, Selector: %@, Reason: %@",
              target, NSStringFromSelector(self.selector), exception.reason);
    }
}

- (void)safe_invoke {
    @try {
        [self safe_invoke];
    } @catch (NSException *exception) {
        NSLog(@"[TURBOMODULE CRASH PREVENTED] Target: %@, Selector: %@, Reason: %@",
              self.target, NSStringFromSelector(self.selector), exception.reason);
    }
}

@end
