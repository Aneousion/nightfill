//! Nightfill batch anchor.
//!
//! The matching engine lives off-chain (inside a simulated TEE in this MVP).
//! This contract does not see orders. The operator posts one record per batch:
//! the Merkle root of fill receipts, the uniform price, and the code measurement
//! the engine claims. Receipt signatures are checked off-chain against
//! `engine_sign_public_key`, which is fixed at init.

use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId, PanicOnDefault};

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct BatchRecord {
    pub batch_id: String,
    pub merkle_root_hex: String,
    pub receipt_count: u32,
    pub pair: String,
    pub uniform_price: String,
    pub matched_base: String,
    pub routed_base: String,
    pub code_measurement: String,
    pub anchored_at_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct ContractInfo {
    pub operator: AccountId,
    pub engine_sign_public_key: String,
    pub batch_count: u64,
    pub latest_batch_id: Option<String>,
    pub pair: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    operator: AccountId,
    engine_sign_public_key: String,
    batches: LookupMap<String, BatchRecord>,
    latest_batch_id: Option<String>,
    batch_count: u64,
}

#[near]
impl Contract {
    #[init]
    pub fn new(engine_sign_public_key: String) -> Self {
        assert_hex(&engine_sign_public_key, 64, "engine_sign_public_key");
        Self {
            operator: env::predecessor_account_id(),
            engine_sign_public_key: engine_sign_public_key.to_ascii_lowercase(),
            batches: LookupMap::new(b"b"),
            latest_batch_id: None,
            batch_count: 0,
        }
    }

    pub fn anchor_batch(
        &mut self,
        batch_id: String,
        merkle_root_hex: String,
        receipt_count: u32,
        pair: String,
        uniform_price: String,
        matched_base: String,
        routed_base: String,
        code_measurement: String,
    ) {
        assert_eq!(
            env::predecessor_account_id(),
            self.operator,
            "only the operator can anchor a batch"
        );
        assert_id(&batch_id);
        assert_hex(&merkle_root_hex, 64, "merkle_root_hex");
        assert_hex(&code_measurement, 64, "code_measurement");
        assert!(receipt_count > 0, "receipt_count must be positive");
        assert_eq!(pair, "NEAR/USDC", "this MVP anchors NEAR/USDC only");
        assert!(uniform_price.len() <= 40, "uniform_price too long");
        assert!(matched_base.len() <= 40, "matched_base too long");
        assert!(routed_base.len() <= 40, "routed_base too long");
        assert!(
            self.batches.get(&batch_id).is_none(),
            "batch already anchored"
        );

        let record = BatchRecord {
            batch_id: batch_id.clone(),
            merkle_root_hex: merkle_root_hex.to_ascii_lowercase(),
            receipt_count,
            pair,
            uniform_price,
            matched_base,
            routed_base,
            code_measurement: code_measurement.to_ascii_lowercase(),
            anchored_at_ms: env::block_timestamp_ms(),
        };

        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"nightfill\",\"version\":\"1.0.0\",\"event\":\"anchor_batch\",\"data\":{{\"batch_id\":\"{}\",\"merkle_root_hex\":\"{}\",\"receipt_count\":{},\"pair\":\"NEAR/USDC\"}}}}",
            record.batch_id, record.merkle_root_hex, record.receipt_count
        ));

        self.batches.insert(batch_id.clone(), record);
        self.latest_batch_id = Some(batch_id);
        self.batch_count += 1;
    }

    pub fn get_batch(&self, batch_id: String) -> Option<BatchRecord> {
        self.batches.get(&batch_id).cloned()
    }

    pub fn get_latest(&self) -> Option<BatchRecord> {
        self.latest_batch_id
            .as_ref()
            .and_then(|id| self.batches.get(id).cloned())
    }

    pub fn get_info(&self) -> ContractInfo {
        ContractInfo {
            operator: self.operator.clone(),
            engine_sign_public_key: self.engine_sign_public_key.clone(),
            batch_count: self.batch_count,
            latest_batch_id: self.latest_batch_id.clone(),
            pair: "NEAR/USDC".to_string(),
        }
    }
}

fn assert_hex(value: &str, len: usize, name: &str) {
    let ok = value.len() == len && value.bytes().all(|b| b.is_ascii_hexdigit());
    assert!(ok, "{name} must be {len} hex characters");
}

fn assert_id(value: &str) {
    let ok = !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    assert!(ok, "bad batch_id");
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn set_predecessor(account: AccountId) {
        let mut builder = VMContextBuilder::new();
        builder
            .predecessor_account_id(account)
            .current_account_id(accounts(1));
        testing_env!(builder.build());
    }

    fn root(byte: u8) -> String {
        format!("{:02x}", byte).repeat(32)
    }

    #[test]
    fn batch_json_uses_snake_case() {
        let record = BatchRecord {
            batch_id: "bt_demo".into(),
            merkle_root_hex: root(0x11),
            receipt_count: 1,
            pair: "NEAR/USDC".into(),
            uniform_price: "3.22".into(),
            matched_base: "1".into(),
            routed_base: "0".into(),
            code_measurement: root(0x22),
            anchored_at_ms: 0,
        };
        let json = near_sdk::serde_json::to_string(&record).unwrap();
        assert!(
            json.contains("merkle_root_hex"),
            "expected snake_case JSON, got {json}"
        );
    }

    #[test]
    fn anchors_and_reads_back() {
        set_predecessor(accounts(0));
        let mut contract = Contract::new(root(0xab));
        contract.anchor_batch(
            "bt_demo".to_string(),
            root(0x11),
            3,
            "NEAR/USDC".to_string(),
            "3.220000".to_string(),
            "8".to_string(),
            "21".to_string(),
            root(0x22),
        );
        let stored = contract.get_batch("bt_demo".to_string()).expect("stored");
        assert_eq!(stored.merkle_root_hex, root(0x11));
        assert_eq!(stored.receipt_count, 3);
        assert_eq!(contract.get_latest().unwrap().batch_id, "bt_demo");
        assert_eq!(contract.get_info().batch_count, 1);
        assert_eq!(contract.get_info().operator, accounts(0));
    }

    #[test]
    #[should_panic(expected = "batch already anchored")]
    fn rejects_a_second_write_of_the_same_batch() {
        set_predecessor(accounts(0));
        let mut contract = Contract::new(root(0xab));
        contract.anchor_batch(
            "bt_demo".into(),
            root(0x11),
            1,
            "NEAR/USDC".into(),
            "3.22".into(),
            "1".into(),
            "0".into(),
            root(0x22),
        );
        contract.anchor_batch(
            "bt_demo".into(),
            root(0x33),
            1,
            "NEAR/USDC".into(),
            "3.22".into(),
            "1".into(),
            "0".into(),
            root(0x22),
        );
    }

    #[test]
    #[should_panic(expected = "only the operator")]
    fn rejects_a_stranger() {
        set_predecessor(accounts(0));
        let mut contract = Contract::new(root(0xab));
        set_predecessor(accounts(2));
        contract.anchor_batch(
            "bt_other".into(),
            root(0x11),
            1,
            "NEAR/USDC".into(),
            "3.22".into(),
            "1".into(),
            "0".into(),
            root(0x22),
        );
    }
}
