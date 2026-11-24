use tokio::sync::watch;

pub const CANCELLED: &str = "Test cancelled";

#[derive(Default)]
pub struct ManualPing {
    id: u32,
    cancel: Option<watch::Sender<bool>>,
}

impl ManualPing {
    pub fn begin(&mut self) -> Result<u32, String> {
        if self.cancel.is_some() {
            return Err("A server test is already running".into());
        }
        self.id = self.id.wrapping_add(1);
        self.cancel = Some(watch::channel(false).0);
        Ok(self.id)
    }

    pub fn subscribe(&self, id: u32) -> Result<watch::Receiver<bool>, String> {
        self.cancel
            .as_ref()
            .filter(|_| self.id == id)
            .map(watch::Sender::subscribe)
            .ok_or_else(|| CANCELLED.into())
    }

    pub fn cancel(&self, id: u32) {
        if let Some(sender) = self.cancel.as_ref().filter(|_| self.id == id) {
            sender.send_replace(true);
        }
    }

    pub fn finish(&mut self, id: u32) {
        if self.id == id {
            self.cancel = None;
        }
    }
}

pub async fn wait_until_cancelled(cancel: &mut watch::Receiver<bool>) {
    // Dropping the sender also cancels an outstanding request.
    let _ = cancel.wait_for(|requested| *requested).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_survives_until_native_probes_subscribe() {
        let mut test = ManualPing::default();
        let first = test.begin().unwrap();
        assert!(test.begin().is_err());
        test.cancel(first);
        assert!(*test.subscribe(first).unwrap().borrow());
        test.finish(first);
        let second = test.begin().unwrap();
        test.cancel(first);
        assert!(!*test.subscribe(second).unwrap().borrow());
        assert!(test.subscribe(first).is_err());
    }
}
