import BigNumber from "bignumber.js";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { Program, AnchorProvider, BN } from "@project-serum/anchor";
import {
  getAssociatedTokenAddress,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,createTransferInstruction
} from "@solana/spl-token";
import idl from "./idl.json";

const opts = { preflightCommitment: "processed" };
const programID = new PublicKey("RAPRxaJc8Xz2bqD3deoQLqT5noS8zsw1zWwBu95mijo");
const tokenAddress = new PublicKey("RAPRz9fd87y9qcBGj1VVqUbbUM6DaBggSDA58zc3N2b");
const treasuryAccount = new PublicKey('54JSyhobm4StWne5LB3QBhUqd9ua6xMhUDma9zwenEtR');

# ADD YOUR OWN SOLANA RPC(Helius,etc)
const endpoints = []

const network = endpoints[1];

const SolanaInteraction = {
  
  provider: typeof window !== 'undefined' 
    ? new AnchorProvider(
        new Connection(network, opts.preflightCommitment), 
        window.solana, 
        opts.preflightCommitment
      ) 
    : null,

  async connectWallet(setWalletAddress, setBalance, setStakedBalance) {
    const { solana } = window;
    if (!solana) return;

    try {
      const response = await solana.connect();
      const publicKey = response.publicKey
      setWalletAddress(publicKey.toString());
      await this.fetchBalance(publicKey, setBalance);
      await this.fetchStakedBalance(publicKey, setStakedBalance);
      return this.provider.wallet
    } catch (err) {
      console.error("Error connecting wallet:", err);
    }
  },

  getProvider() {
    return this.provider;
  },
  async transferRaprBalance(sourceWallet, destinationWallet, amount) {
    const provider = this.getProvider();
    const connection = provider.connection;

    const sourcePublicKey = new PublicKey(sourceWallet);
    const destinationPublicKey = new PublicKey(destinationWallet);

    const sourceTokenAccount = await getAssociatedTokenAddress(tokenAddress, sourcePublicKey, false, TOKEN_2022_PROGRAM_ID);
    const destinationTokenAccount = await getAssociatedTokenAddress(tokenAddress, destinationPublicKey, false, TOKEN_2022_PROGRAM_ID);

    const transaction = new Transaction().add(
      createTransferInstruction(
        sourceTokenAccount,
        destinationTokenAccount,
        sourcePublicKey,
        amount * 1e9, // Convert amount to smallest unit
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );

    try {
      const signature = await provider.sendAndConfirm(transaction, [provider.wallet.payer]);
      console.log('Transfer successful, signature:', signature);
    } catch (err) {
      console.error('Error transferring RAPR balance:', err);
    }
  },
  async createRaprTokenAccountIfNeeded(wallet) {
    const userRaprAccount = await getAssociatedTokenAddress(tokenAddress, wallet, false, TOKEN_2022_PROGRAM_ID);
    try {
      await this.getProvider().connection.getTokenAccountBalance(userRaprAccount);
      return null; // Account exists
    } catch {
      // Account doesn't exist, create it
      return createAssociatedTokenAccountInstruction(wallet, userRaprAccount, wallet, tokenAddress, TOKEN_2022_PROGRAM_ID);
    }
  },

  async fetchTokenAccount(publicKey) {
    const accounts = await this.getProvider().connection.getTokenAccountsByOwner(publicKey, { mint: tokenAddress });
    return accounts.value[0];
  },

  async fetchBalance(publicKey, setBalance) {
    try {
      const account = await this.fetchTokenAccount(publicKey);
      const { value } = await this.getProvider().connection.getTokenAccountBalance(account.pubkey);
      setBalance(value.uiAmount);
    return value
  } catch (err) {
      console.error("Error fetching balance:", err);
    }
  },

  async fetchStakedBalance(publicKey, setStakedBalance) {
    const userState = await this.getUserState(publicKey);
    if (userState) {
      const stakedAmount = new BN(userState.stakedRapr.toString()).toNumber();
      const formattedStakedBalance = (stakedAmount / 1e9);
      setStakedBalance(formattedStakedBalance);
    }
  },


  calculateStakingReward(amount, stakingDuration, rewardRate) {
    const SECONDS_PER_DAY = new BigNumber(86400);
    const rewardRatePerSecond = rewardRate.multipliedBy(10000).div(SECONDS_PER_DAY);
    return amount.multipliedBy(stakingDuration).multipliedBy(rewardRatePerSecond).div(10000 ** 2);
  },

  async stakeOrUnstakeRapr(isStaking, amount,setBalance,setStakedBalance) {
    const provider = this.getProvider();
    const wallet = provider.wallet.publicKey;
    const program = new Program(idl, programID, provider);
    const amountBN = new BN(Number(amount) * 1e9);

    if (isStaking) {
      await this.handleStake(amountBN, wallet, provider.connection, program);
    } else {
      await this.handleUnstake(amountBN,wallet, provider.connection, program);
    }

    await this.fetchBalance(wallet, setBalance);
    await this.fetchStakedBalance(wallet, setStakedBalance);
  },

  async getUserState(publicKey) {
    const provider = this.getProvider();
    const program = new Program(idl, programID, provider);
    const [userState] = await PublicKey.findProgramAddress([Buffer.from('user_state'), publicKey.toBuffer()], programID);

    try {
      return await program.account.userState.fetch(userState);
    } catch  {
      console.log('User state not initialized yet');
      return null;
    }
  },

  async handleStake(amountBN, wallet, connection, program) {
    const userRaprAccount = await getAssociatedTokenAddress(tokenAddress, wallet, false, TOKEN_2022_PROGRAM_ID);
    const [programState] = await PublicKey.findProgramAddress([Buffer.from('program_state')], programID);
    const [userState] = await PublicKey.findProgramAddress([Buffer.from('user_state'), wallet.toBuffer()], programID);
    const stakingAccount = await getAssociatedTokenAddress(tokenAddress, programState, true, TOKEN_2022_PROGRAM_ID);

    const preInstructions = await this.createRaprTokenAccountIfNeeded(wallet);
    const stakeIx = await program.methods.stakeRapr(amountBN)
      .preInstructions(preInstructions ? [preInstructions] : [])
      .accounts({
        userState,
        userRaprAccount,
        userAuthority: wallet,
        stakingAccount,
        programState,
        raprMint: tokenAddress,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    await this.sendTransaction(stakeIx, wallet, connection);
  },

  async handleUnstake(amountBN,wallet, connection, program) {
    const userState = await this.getUserState(wallet);
    if (!userState) throw new Error('User state not found');


    const [programState, userStatePDA] = await Promise.all([
      PublicKey.findProgramAddress([Buffer.from('program_state')], programID),
      PublicKey.findProgramAddress([Buffer.from('user_state'), wallet.toBuffer()], programID)
    ]);

    const userRaprAccount = await getAssociatedTokenAddress(tokenAddress, wallet, false, TOKEN_2022_PROGRAM_ID);
    const stakingAccount = await getAssociatedTokenAddress(tokenAddress, programState[0], true, TOKEN_2022_PROGRAM_ID);
    const unstakeIx = await program.methods.unstakeRapr(amountBN)
      .accounts({
        userState: userStatePDA[0],
        userRaprAccount,
        userAuthority: wallet,
        stakingAccount,
        treasuryAccount,
        programState: programState[0],
        raprMint: tokenAddress,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const createAccountIx = await this.createRaprTokenAccountIfNeeded(wallet);
    const instructions = createAccountIx ? [createAccountIx, unstakeIx] : [unstakeIx];

    await this.sendTransaction(instructions, wallet, connection);
  },

  async sendTransaction(instructions, wallet, connection) {
    const tx = new Transaction().add(...(Array.isArray(instructions) ? instructions : [instructions]));
    tx.feePayer = wallet;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    try {
      const signedTx = await this.getProvider().wallet.signTransaction(tx);
      const signature = await connection.sendRawTransaction(signedTx.serialize());
      await connection.confirmTransaction(signature);
      console.log("Transaction successful");
    } catch (err) {
      console.error("Transaction error:", err);
    }
  }
};

export default SolanaInteraction;
