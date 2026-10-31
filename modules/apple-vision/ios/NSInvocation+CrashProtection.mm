#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#include <exception>

/**
 * TurboModuleCrashProtection (Objective-C++)
 *
 * Intercepts uncaught exceptions inside NSInvocation's invoke and invokeWithTarget:.
 * React Native's ObjCTurboModule::performVoidMethodInvocation dispatches async void
 * method invocations onto a GCD queue without an outer C++ catch handler. If an invoked
 * method throws an NSException or C++ exception, it triggers std::terminate() and abort() (SIGABRT).
 *
 * By catching both NSException and std::exception inside invokeWithTarget: and invoke,
 * no exception escapes to GCD, preventing the abort trap and keeping the app running smoothly.
 */

@interface TurboModuleCrashGuard : NSObject
+ (void)install;
@end

@implementation TurboModuleCrashGuard
+ (void)install {
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
    } catch (const std::exception &e) {
        NSLog(@"[TURBOMODULE STD::EXCEPTION PREVENTED] Target: %@, Selector: %@, Reason: %s",
              target, NSStringFromSelector(self.selector), e.what());
    } catch (...) {
        NSLog(@"[TURBOMODULE UNKNOWN EXCEPTION PREVENTED] Target: %@, Selector: %@",
              target, NSStringFromSelector(self.selector));
    }
}

- (void)safe_invoke {
    @try {
        [self safe_invoke];
    } @catch (NSException *exception) {
        NSLog(@"[TURBOMODULE CRASH PREVENTED] Target: %@, Selector: %@, Reason: %@",
              self.target, NSStringFromSelector(self.selector), exception.reason);
    } catch (const std::exception &e) {
        NSLog(@"[TURBOMODULE STD::EXCEPTION PREVENTED] Target: %@, Selector: %@, Reason: %s",
              self.target, NSStringFromSelector(self.selector), e.what());
    } catch (...) {
        NSLog(@"[TURBOMODULE UNKNOWN EXCEPTION PREVENTED] Target: %@, Selector: %@",
              self.target, NSStringFromSelector(self.selector));
    }
}

@end
