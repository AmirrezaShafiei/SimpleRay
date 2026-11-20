use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::{HashMap, VecDeque}, time::{Duration, Instant}};

pub const LIVE_INTERVAL: Duration = Duration::from_secs(10);
pub const ROUND_INTERVAL: Duration = Duration::from_secs(30);
pub const SWITCH_COOLDOWN: Duration = Duration::from_secs(90);
pub const UNDO_WINDOW: Duration = Duration::from_secs(20);
pub const MAX_CANDIDATES: usize = 6;

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SwitchMode {
    #[default]
    Off,
    Suggest,
    Automatic,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub server_id: String,
    pub outbound: Value,
    #[serde(default)]
    pub display_name: String,
}

#[derive(Default)]
pub struct Samples(VecDeque<Option<u64>>);

impl Samples {
    pub fn push(&mut self, value: Option<u64>) {
        if self.0.len() == 10 { self.0.pop_front(); }
        self.0.push_back(value);
    }

    pub fn counts(&self) -> (usize, usize) {
        (self.0.iter().filter(|sample| sample.is_some()).count(), self.0.len())
    }

    pub fn estimate(&self) -> Option<u64> {
        self.0.back()?.as_ref()?;
        let mut recent: Vec<_> = self.0.iter().rev().take(3).filter_map(|sample| *sample).collect();
        recent.sort_unstable();
        recent.get(recent.len() / 2).copied()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SwitchReason { Recovery, LowerLatency }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchDecision {
    pub server_id: String,
    pub previous_ms: Option<u64>,
    pub candidate_ms: u64,
    pub reason: SwitchReason,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraySuggestion {
    pub generation: u64,
    pub revision: u64,
    pub name: String,
    pub decision: SwitchDecision,
}

impl TraySuggestion {
    pub fn same_offer(&self, other: &Self)->bool {
        self.generation==other.generation
            && self.revision==other.revision
            && self.decision.server_id==other.decision.server_id
            && self.decision.reason==other.decision.reason
    }
}

#[derive(Default)]
struct CandidateHealth {
    samples: Samples,
    qualifying_rounds: u8,
}

#[derive(Default)]
pub struct CandidateHistory(HashMap<String, CandidateHealth>);

impl CandidateHistory {
    pub fn observe(&mut self, id: &str, value: Option<u64>, active_ms: Option<u64>) {
        let health = self.0.entry(id.to_owned()).or_default();
        health.samples.push(value);
        health.qualifying_rounds = if qualifies(active_ms, value) {
            health.qualifying_rounds.saturating_add(1)
        } else {
            0
        };
    }

    pub fn choose(&self, active_ms: Option<u64>, failed: bool) -> Option<SwitchDecision> {
        self.0.iter().filter_map(|(id, health)| {
            let candidate_ms = health.samples.estimate()?;
            let (successes, attempts) = health.samples.counts();
            let stable = attempts >= 2 && successes * 5 >= attempts * 4;
            let reason = if failed {
                SwitchReason::Recovery
            } else if stable && health.qualifying_rounds >= 2 && qualifies(active_ms, Some(candidate_ms)) {
                SwitchReason::LowerLatency
            } else {
                return None;
            };
            Some((stable, SwitchDecision { server_id: id.clone(), previous_ms: active_ms, candidate_ms, reason }))
        }).min_by(|(stable_a, a), (stable_b, b)| {
            stable_b.cmp(stable_a).then(a.candidate_ms.cmp(&b.candidate_ms)).then(a.server_id.cmp(&b.server_id))
        }).map(|(_, decision)| decision)
    }
}

pub fn qualifies(active: Option<u64>, candidate: Option<u64>) -> bool {
    active.zip(candidate).is_some_and(|(active, candidate)| {
        let reduction = active.saturating_sub(candidate);
        reduction >= 150 && reduction as u128 * 100 >= active as u128 * 40
    })
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthStatus {
    pub latency_ms: Option<u64>,
    pub measured_at_ms: Option<u64>,
    pub successes: usize,
    pub attempts: usize,
    pub consecutive_failures: u8,
    pub checking: bool,
    pub switching: bool,
    pub waiting: bool,
    pub no_candidates: bool,
    pub recovering: bool,
    pub suggestion: Option<SwitchDecision>,
    pub switched: Option<SwitchDecision>,
    pub can_undo: bool,
}

#[derive(Default)]
pub struct Monitor {
    pub wanted: Option<Profile>,
    pub mode: SwitchMode,
    pub candidates: Vec<Profile>,
    pub revision: u64,
    pub live: Samples,
    pub last_ms: Option<u64>,
    pub measured_at_ms: Option<u64>,
    pub failures: u8,
    pub next_live: Option<Instant>,
    pub next_round: Option<Instant>,
    pub round_started: Option<Instant>,
    pub history: CandidateHistory,
    pub suggestion: Option<(SwitchDecision, Instant)>,
    pub switched: Option<(SwitchDecision, Instant)>,
    pub undo: Option<(Profile, Instant)>,
    pub cooldown: Option<Instant>,
    pub checking: bool,
    pub retry_delay: Option<Duration>,
}

impl Monitor {
    pub fn reset_session(&mut self, wanted: Option<Profile>, initial_ms: Option<u64>, now: Instant) {
        self.wanted = wanted;
        self.live = Samples::default();
        self.failures = 0;
        self.last_ms = None;
        self.measured_at_ms = None;
        self.next_live = Some(now + LIVE_INTERVAL);
        self.reset_candidates(now);
        self.switched = None;
        self.undo = None;
        self.cooldown = None;
        if let Some(ms) = initial_ms { self.record_live(Some(ms)); }
    }

    pub fn reset_candidates(&mut self, now: Instant) {
        self.revision = self.revision.wrapping_add(1);
        self.history = CandidateHistory::default();
        self.suggestion = None;
        self.checking = false;
        self.retry_delay = None;
        self.round_started = None;
        self.next_round = Some(now);
    }

    pub fn record_live(&mut self, ms: Option<u64>) {
        self.live.push(ms);
        self.last_ms = ms;
        self.measured_at_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .ok().map(|time| time.as_millis() as u64);
    }

    pub fn record_scheduled(&mut self, ms: Option<u64>, now: Instant) {
        self.record_live(ms);
        self.failures = if ms.is_some() { 0 } else { self.failures.saturating_add(1) };
        if (ms.is_some() && self.retry_delay.take().is_some()) || self.failures == 2 {
            self.next_round = Some(now);
        }
        if ms.is_some() && self.suggestion.as_ref().is_some_and(|(decision, _)| decision.reason == SwitchReason::Recovery) {
            self.suggestion = None;
        }
    }

    pub fn retry_later(&mut self, now: Instant) {
        let delay = self.retry_delay.map_or(ROUND_INTERVAL, |last| (last * 2).min(Duration::from_secs(120)));
        self.retry_delay = Some(delay);
        self.next_round = Some(now + delay);
        self.suggestion = None;
    }

    pub fn view(&self, recovering: bool, now: Instant) -> HealthStatus {
        let (successes, attempts) = self.live.counts();
        let has_candidates = self.wanted.as_ref().is_some_and(|active| {
            self.candidates.iter().any(|candidate| candidate.server_id != active.server_id)
        });
        HealthStatus {
            latency_ms: self.last_ms, measured_at_ms: self.measured_at_ms,
            successes, attempts, consecutive_failures: self.failures,
            checking: self.checking, switching: false, waiting: self.retry_delay.is_some(),
            no_candidates: self.mode != SwitchMode::Off && !has_candidates,
            recovering, suggestion: self.suggestion.as_ref().filter(|(_, expiry)| now < *expiry).map(|(item, _)| item.clone()),
            switched: self.switched.as_ref().filter(|(_, expiry)| now < *expiry).map(|(item, _)| item.clone()),
            can_undo: self.undo.as_ref().is_some_and(|(_, expiry)| now < *expiry),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn healthy_switch_requires_both_thresholds_and_two_consecutive_rounds() {
        assert!(qualifies(Some(375), Some(225)));
        assert!(!qualifies(Some(300), Some(170)));
        assert!(!qualifies(Some(500), Some(330)));
        let mut history = CandidateHistory::default();
        history.observe("a", Some(100), Some(250));
        assert!(history.choose(Some(250), false).is_none());
        history.observe("a", Some(100), Some(250));
        assert_eq!(history.choose(Some(250), false).unwrap().server_id, "a");
        history.observe("a", None, Some(250));
        assert!(history.choose(Some(250), false).is_none());
    }

    #[test]
    fn recovery_accepts_a_fresh_success_even_with_higher_latency() {
        let mut history = CandidateHistory::default();
        history.observe("a", Some(500), None);
        let decision = history.choose(None, true).unwrap();
        assert_eq!(decision.candidate_ms, 500);
        assert!(decision.reason == SwitchReason::Recovery);
        history.observe("a", None, None);
        assert!(history.choose(None, true).is_none());
    }

    #[test]
    fn manual_samples_count_but_do_not_advance_recovery_and_backoff_is_bounded() {
        let now = Instant::now();
        let mut monitor = Monitor::default();
        monitor.record_live(None);
        assert_eq!(monitor.failures, 0);
        monitor.record_scheduled(None, now);
        monitor.record_scheduled(None, now);
        assert_eq!(monitor.failures, 2);
        assert_eq!(monitor.next_round, Some(now));
        for _ in 0..10 { monitor.retry_later(now); }
        assert_eq!(monitor.retry_delay, Some(Duration::from_secs(120)));
        monitor.record_scheduled(Some(123), now);
        assert_eq!(monitor.failures, 0);
        assert_eq!(monitor.retry_delay, None);
        assert_eq!(monitor.live.counts(), (1, 4));
    }
}
