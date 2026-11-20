use std::{
    collections::HashSet,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use client_native::NativeError;

/// A request keeps the token of the main document that issued it, not of a later reload.
#[derive(Clone, Default)]
pub struct Lifetime(Arc<AtomicBool>);

impl Lifetime {
    /// Run on the UI thread for native mutations, where reload invalidation is also dispatched.
    pub fn run_if_current<T>(
        &self,
        action: impl FnOnce() -> Result<T, NativeError>,
    ) -> Result<T, NativeError> {
        self.check()?;
        action()
    }

    pub fn check(&self) -> Result<(), NativeError> {
        if self.0.load(Ordering::Acquire) {
            Err(super::preview_unavailable())
        } else {
            Ok(())
        }
    }
}

#[derive(Default)]
struct Inner {
    lifetime: Lifetime,
    labels: HashSet<String>,
}

#[derive(Default)]
pub struct Registry(Mutex<Inner>);

impl Registry {
    pub fn lifetime(&self) -> Result<Lifetime, NativeError> {
        Ok(self
            .0
            .lock()
            .map_err(|_| super::preview_unavailable())?
            .lifetime
            .clone())
    }

    pub fn register(&self, label: String, lifetime: &Lifetime) -> Result<(), NativeError> {
        let mut inner = self.0.lock().map_err(|_| super::preview_unavailable())?;
        // The same lock guards invalidation and registration, so cleanup cannot miss a late insert.
        lifetime.check()?;
        inner.labels.insert(label);
        Ok(())
    }

    pub fn unregister(&self, label: &str) -> Result<(), NativeError> {
        self.0
            .lock()
            .map_err(|_| super::preview_unavailable())?
            .labels
            .remove(label);
        Ok(())
    }

    pub fn take_all(&self) -> Result<Vec<String>, NativeError> {
        let mut inner = self.0.lock().map_err(|_| super::preview_unavailable())?;
        inner.lifetime.0.store(true, Ordering::Release);
        inner.lifetime = Lifetime::default();
        Ok(inner.labels.drain().collect())
    }

    pub fn restore(&self, labels: impl IntoIterator<Item = String>) {
        if let Ok(mut inner) = self.0.lock() {
            inner.labels.extend(labels);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reload_invalidates_waiting_requests_and_rejects_late_registration() {
        let registry = Registry::default();
        let old = registry.lifetime().unwrap();
        registry.register("old".into(), &old).unwrap();
        assert_eq!(registry.take_all().unwrap(), vec!["old"]);
        assert!(old.check().is_err());
        assert!(registry.register("late".into(), &old).is_err());
        let new = registry.lifetime().unwrap();
        registry.register("new".into(), &new).unwrap();
        assert!(new.check().is_ok());
        assert_eq!(registry.take_all().unwrap(), vec!["new"]);
        assert!(new.check().is_err());
    }

    #[test]
    fn reload_blocks_queued_navigation_and_show() {
        let registry = Registry::default();
        let lifetime = registry.lifetime().unwrap();
        registry.take_all().unwrap();
        let mut navigated = false;
        assert!(
            lifetime
                .run_if_current(|| {
                    navigated = true;
                    Ok(())
                })
                .is_err()
        );
        assert!(!navigated);
        // The replacement document is not blocked by the old request's cancellation.
        registry
            .lifetime()
            .unwrap()
            .run_if_current(|| {
                navigated = true;
                Ok(())
            })
            .unwrap();
        assert!(navigated);
    }
}
