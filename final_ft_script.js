const {
    Hbar,
    Client,
    PrivateKey,
    AccountBalanceQuery,
    AccountCreateTransaction,
    TokenCreateTransaction,
    TokenType,
    TokenSupplyType,
    TokenAssociateTransaction,
    TransferTransaction,
    TokenMintTransaction
  } = require("@hashgraph/sdk");
  require("dotenv").config();

// --- CONFIGURATION CONSTANTS ---
const WHOLE_TOKENS_DECIMALS = 2;
const INITIAL_SUPPLY_TOKENS = 1000;
const RECIPIENT_A_INITIAL_TRANSFER = 50; // To match 950/50 split
const MINT_NEW_TOKENS = 500;
const BULK_DISTRIBUTE_AMOUNT = 100; // Amount sent to Recipient A and B in Step 4

// Helper to convert whole tokens to smallest unit (units)
const toSmallestUnit = (amount) => amount * Math.pow(10, WHOLE_TOKENS_DECIMALS);

async function checkBalances(client, myAccountId, newAccountId, newAccountId2, tokenId, tokenSymbol) {
    console.log(`\n--- Querying Balances for ${tokenSymbol} ---`);
    
    const accounts = [
        { id: myAccountId, name: "Treasury" },
        { id: newAccountId, name: "Recipient A" },
        { id: newAccountId2, name: "Recipient B" }
    ];

    for (const account of accounts) {
        if (!account.id) continue;
        
        const balanceQuery = new AccountBalanceQuery().setAccountId(account.id);
        const tokenBalances = await balanceQuery.execute(client);
        const balance = tokenBalances.tokens.get(tokenId.toString()) || 0;
        const wholeTokens = (balance / Math.pow(10, WHOLE_TOKENS_DECIMALS)).toFixed(WHOLE_TOKENS_DECIMALS);
        
        console.log(`- ${account.name} (${account.id}) Balance: ${wholeTokens} ${tokenSymbol}`);
    }
}

async function executeFungibleTokenProject() {
    // 1. ENVIRONMENT SETUP
    const myAccountId = process.env.MY_ACCOUNT_ID;
    const myPrivateKey = process.env.MY_PRIVATE_KEY;
    const TOKEN_SYMBOL = "MYT";
  
    if (myAccountId == null || myPrivateKey == null) {
      throw new Error("Environment variables MY_ACCOUNT_ID and MY_PRIVATE_KEY must be present");
    }

    // ⭐ CRITICAL FIX: Explicitly parse the private key as ECDSA ⭐
    // .trim() removes any accidental whitespace which can also cause signature errors
    const operatorKey = PrivateKey.fromStringECDSA(myPrivateKey.trim());
    const treasuryKey = operatorKey; 
    const supplyKey = PrivateKey.generate(); // New Supply Key for the token

    const client = Client.forTestnet();
    client.setOperator(myAccountId, operatorKey);
    client.setDefaultMaxTransactionFee(new Hbar(100));
    client.setDefaultMaxQueryPayment(new Hbar(50));

    // --- Create Recipient Accounts A and B (for token transfer) ---
    const newAccountPrivateKey = PrivateKey.generateED25519(); // Recipient A Key
    const newAccount2PrivateKey = PrivateKey.generateED25519(); // Recipient B Key

    // 1. Create Recipient A (Initial Recipient)
    const newAccountTx = await new AccountCreateTransaction()
        .setKey(newAccountPrivateKey.publicKey)
        .setInitialBalance(Hbar.fromTinybars(1000))
        .execute(client);
    const newAccountReceipt = await newAccountTx.getReceipt(client);
    const newAccountId = newAccountReceipt.accountId;
    console.log(`\n✅ Recipient A (Initial Recipient) ID: ${newAccountId}`);

    // 2. Create Recipient B (For bulk distribution in Step 4)
    const newAccount2Tx = await new AccountCreateTransaction()
        .setKey(newAccount2PrivateKey.publicKey)
        .setInitialBalance(Hbar.fromTinybars(1000))
        .execute(client);
    const newAccount2Receipt = await newAccount2Tx.getReceipt(client);
    const newAccountId2 = newAccount2Receipt.accountId;
    console.log(`✅ Recipient B (Bulk Distribution Target) ID: ${newAccountId2}`);
    
    // =========================================================================
    // STEP 1 & 2: Create a fungible token and transfer it between accounts.
    // =========================================================================
    
    console.log("\n--- STEP 1 & 2A: Creating Token ---");
    const initialSupplyUnits = toSmallestUnit(INITIAL_SUPPLY_TOKENS); 

    let tokenCreateTx = await new TokenCreateTransaction()
        .setTokenName("MyToken")
        .setTokenSymbol(TOKEN_SYMBOL)
        .setTokenType(TokenType.FungibleCommon)
        .setDecimals(WHOLE_TOKENS_DECIMALS)
        .setInitialSupply(initialSupplyUnits)
        .setTreasuryAccountId(myAccountId)
        .setSupplyType(TokenSupplyType.Infinite) 
        .setSupplyKey(supplyKey) // Enables minting later
        .freezeWith(client);

    let tokenCreateSign = await tokenCreateTx.sign(treasuryKey); // Signed by ECDSA key
    let tokenCreateSubmit = await tokenCreateSign.execute(client);
    let tokenCreateRx = await tokenCreateSubmit.getReceipt(client);
    let tokenId = tokenCreateRx.tokenId;
    console.log(`✅ Token Created: ${TOKEN_SYMBOL} (ID: ${tokenId})`);
   
    // --- 2B: Associate Recipient A ---
    console.log("\n--- STEP 2B: Associating Recipient A ---");
    const associateA = await new TokenAssociateTransaction()
        .setAccountId(newAccountId)
        .setTokenIds([tokenId])
        .freezeWith(client)
        .sign(newAccountPrivateKey);
    await associateA.execute(client).then(tx => tx.getReceipt(client));
    console.log("✅ Recipient A associated successfully.");

    // --- 2C: Initial Transfer (50 tokens) ---
    const transferAmountUnit = toSmallestUnit(RECIPIENT_A_INITIAL_TRANSFER); 

    console.log(`\n--- STEP 2C: Initial Transfer of ${RECIPIENT_A_INITIAL_TRANSFER} ${TOKEN_SYMBOL} to Recipient A ---`);
    const transferTransaction = await new TransferTransaction()
        .addTokenTransfer(tokenId, myAccountId, -transferAmountUnit) // Debit Treasury
        .addTokenTransfer(tokenId, newAccountId, transferAmountUnit) // Credit Recipient A
        .freezeWith(client);

    const singTransferTx = await transferTransaction.sign(treasuryKey); 
    await singTransferTx.execute(client).then(tx => tx.getReceipt(client));
    console.log("✅ Initial transfer complete.");


    // =========================================================================
    // STEP 3: Verify Balances (Treasury: 950 / Recipient A: 50)
    // =========================================================================
    console.log("\n==================================================");
    console.log("== STEP 3: Verification (950 Treasury / 50 Recipient) ==");
    await checkBalances(client, myAccountId, newAccountId, null, tokenId, TOKEN_SYMBOL); 
    console.log("==================================================");


    // =========================================================================
    // STEP 4: Mint additional tokens and distribute them to multiple accounts.
    // =========================================================================

    // --- 4A: Mint New Tokens (500 tokens added to Treasury) ---
    const mintAmountUnit = toSmallestUnit(MINT_NEW_TOKENS); 

    console.log(`\n--- STEP 4A: Minting ${MINT_NEW_TOKENS} new ${TOKEN_SYMBOL} into Treasury ---`);

    const mintTx = new TokenMintTransaction()
        .setTokenId(tokenId)
        .setAmount(mintAmountUnit) 
        .freezeWith(client);

    // The token's supply key is NOT the Treasury key, but a new key generated at the start.
    // The Treasury key just signed the token creation transaction. 
    // The script must sign with the actual supply key.
    const mintSign = await mintTx.sign(supplyKey); 
    await mintSign.execute(client).then(tx => tx.getReceipt(client));
    console.log(`✅ Mint successful. Treasury Balance is now ${950 + MINT_NEW_TOKENS} ${TOKEN_SYMBOL}.`);

    // --- 4B: Associate Recipient B (for bulk distribution) ---
    console.log("\n--- STEP 4B: Associating Recipient B ---");
    const associateB = await new TokenAssociateTransaction()
        .setAccountId(newAccountId2)
        .setTokenIds([tokenId])
        .freezeWith(client)
        .sign(newAccount2PrivateKey); 
    await associateB.execute(client).then(tx => tx.getReceipt(client));
    console.log("✅ Recipient B associated successfully.");


    // --- 4C: Bulk Distribution (100 to A, 100 to B) ---
    const bulkAmountUnit = toSmallestUnit(BULK_DISTRIBUTE_AMOUNT); 
    const totalDistributed = BULK_DISTRIBUTE_AMOUNT * 2;

    console.log(`\n--- STEP 4C: Bulk Distribution (Sending ${totalDistributed} ${TOKEN_SYMBOL} total) ---`);
    
    const bulkTransferTx = new TransferTransaction()
        // Treasury (Sender): Debits 200 tokens total
        .addTokenTransfer(tokenId, myAccountId, -toSmallestUnit(totalDistributed))
        // Recipient A: Credits 100 tokens
        .addTokenTransfer(tokenId, newAccountId, bulkAmountUnit)
        // Recipient B: Credits 100 tokens
        .addTokenTransfer(tokenId, newAccountId2, bulkAmountUnit)
        .freezeWith(client);

    const bulkTransferSign = await bulkTransferTx.sign(treasuryKey); 
    await bulkTransferSign.execute(client).then(tx => tx.getReceipt(client));
    console.log("✅ Bulk distribution successful.");


    // =========================================================================
    // FINAL VERIFICATION
    // =========================================================================
    console.log("\n==================================================");
    console.log("== FINAL VERIFICATION ==");
    await checkBalances(client, myAccountId, newAccountId, newAccountId2, tokenId, TOKEN_SYMBOL);
    console.log("==================================================");
}

executeFungibleTokenProject().catch(error => {
    console.error("The script failed during execution:", error);
    process.exit(1);
});