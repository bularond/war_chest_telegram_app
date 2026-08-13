//! Every bot the arena and the server can ask for, behind one type.
//!
//! A `Player` owns its scratch — a search owns a whole tree arena — so it is
//! built once per seat per thread and asked for move after move. That is the
//! difference from the TypeScript, where every bot was a stateless closure and
//! every call rebuilt everything it needed.

use crate::baseline::{greedy_choice, random_choice};
use crate::heuristic::{DraftBy, Heuristic, HeuristicWeights};
use crate::ismcts::{Budget, SearchReport, SearchSettings, Searcher};
use wc_core::rng::Rng;
use wc_core::types::Action;
use wc_core::view::GameView;

pub enum Player {
    Random,
    Greedy(Vec<u32>),
    Heuristic(Box<Heuristic>),
    Search(Box<Searcher>),
}

impl Player {
    pub fn name(&self) -> &'static str {
        match self {
            Player::Random => "random",
            Player::Greedy(_) => "greedy",
            Player::Heuristic(_) => "heuristic",
            Player::Search(_) => "ismcts",
        }
    }

    pub fn choose(&mut self, view: &GameView, budget: Budget, rng: &mut Rng) -> Action {
        debug_assert!(!view.legal.is_empty(), "a bot was asked to choose from nothing");
        match self {
            Player::Random => random_choice(&view.legal, rng),
            Player::Greedy(scratch) => greedy_choice(view, view.you, &view.legal, rng, scratch),
            Player::Heuristic(bot) => {
                let hand = view.players[view.you as usize].hand.clone().unwrap_or_default();
                bot.choose(view, view.you, view.phase, &view.legal, Some(&hand), rng)
            }
            Player::Search(search) => search.choose(view, budget, rng),
        }
    }

    /// The move plus what the search thought of every root move, when there is a
    /// search. Root parallelism needs exactly this and nothing else.
    pub fn choose_reported(
        &mut self,
        view: &GameView,
        budget: Budget,
        rng: &mut Rng,
    ) -> (Action, Option<SearchReport>) {
        match self {
            Player::Search(search) if view.legal.len() > 1 => {
                match search.run(view, budget, rng) {
                    Ok(report) => (report.action, Some(report)),
                    Err(_) => (self.choose(view, budget, rng), None),
                }
            }
            _ => (self.choose(view, budget, rng), None),
        }
    }
}

/// A bot named the way the arena and the CLIs name them.
///
/// The `heuristic-*` entries are the same bot with the undecided knobs flipped.
/// They exist to be played off against each other; once the arena has an answer,
/// the winner becomes `heuristic` and the losers can go.
pub fn player_named(name: &str, settings: &SearchSettings) -> Option<Player> {
    let quick = HeuristicWeights { quick: true, ..HeuristicWeights::default() };
    Some(match name {
        "random" => Player::Random,
        "greedy" => Player::Greedy(Vec::new()),
        "heuristic" => Player::Heuristic(Box::new(Heuristic::default())),
        "heuristic-control" => Player::Heuristic(Box::new(Heuristic::new(HeuristicWeights {
            attack_before_control: false,
            ..HeuristicWeights::default()
        }))),
        "heuristic-kills" => Player::Heuristic(Box::new(Heuristic::new(HeuristicWeights {
            prefer_kills: true,
            ..HeuristicWeights::default()
        }))),
        "heuristic-control-kills" => {
            Player::Heuristic(Box::new(Heuristic::new(HeuristicWeights {
                attack_before_control: false,
                prefer_kills: true,
                ..HeuristicWeights::default()
            })))
        }
        // The heuristic without its priority lists — a rollout policy, not a level.
        "heuristic-quick" => Player::Heuristic(Box::new(Heuristic::new(quick))),
        "heuristic-coins" => Player::Heuristic(Box::new(Heuristic::new(HeuristicWeights {
            draft_by: DraftBy::Coins,
            ..HeuristicWeights::default()
        }))),
        "ismcts" => Player::Search(Box::new(Searcher::new(settings.clone()))),
        "ismcts-quick" => Player::Search(Box::new(Searcher::new(SearchSettings {
            rollout: quick,
            ..settings.clone()
        }))),
        // Fixed iteration counts, for measuring how strength grows with thinking.
        "ismcts-200" => Player::Search(Box::new(Searcher::new(SearchSettings {
            iterations: 200,
            ..settings.clone()
        }))),
        "ismcts-2000" => Player::Search(Box::new(Searcher::new(SearchSettings {
            iterations: 2000,
            ..settings.clone()
        }))),
        _ => return None,
    })
}

/// Which build of the bots this is. Written into the log of every game against
/// the computer, so a win rate can be traced back to what was actually playing.
///
/// `rust@1` is the port: the same rules, the same evaluation and the same
/// search, on an engine that neither copies a state per ply nor allocates per
/// iteration. Nothing about *what* it plays changed — the two engines were held
/// to identical positions and identical legal-move lists over four hundred games
/// before this was written — so a strength difference at equal iteration counts
/// would be a bug. What changed is how many iterations a level buys.
pub const BOT_BUILD: &str = "rust@1";
