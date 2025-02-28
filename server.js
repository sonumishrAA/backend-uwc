import express from "express";
import axios from "axios";
import crypto from "crypto";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Configuration
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Middleware Setup
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use(cors({
  origin: "https://uwcindia.in",
  methods: ["GET", "POST"],
  credentials: true
}));

// PhonePe Constants
const MERCHANT_ID = process.env.MERCHANT_ID;
const MERCHANT_KEY = process.env.MERCHANT_KEY;
const KEY_INDEX = 1;
const PHONEPE_BASE_URL = "https://api.phonepe.com/apis/hermes/pg/v1/pay";
const PHONEPE_STATUS_URL = "https://api.phonepe.com/apis/hermes/pg/v1/status";

// Supabase Client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Helper: Generate SHA256 Checksum
const generateChecksum = (payload, endpoint) => {
  const hash = crypto.createHash("sha256");
  hash.update(payload + endpoint + MERCHANT_KEY);
  return hash.digest("hex") + "###" + KEY_INDEX;
};

// 1. Create Payment Order
app.post("/api/create-order", async (req, res) => {
  try {
    const { amount, name, email, phone } = req.body;
    
    // Validation
    if(!amount || !name || !email || !phone) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Generate Transaction ID
    const transactionId = `TXN_${uuidv4()}`;
    
    // Payment Payload
    const paymentData = {
      merchantId: MERCHANT_ID,
      merchantTransactionId: transactionId,
      merchantUserId: email,
      amount: Math.round(Number(amount) * 100), // Convert to paise
      currency: "INR",
      redirectUrl: "https://backend-uwc.onrender.com/payment/callback",
      redirectMode: "POST",
      callbackUrl: "https://backend-uwc.onrender.com/payment/callback",
      mobileNumber: phone,
      paymentInstrument: { type: "PAY_PAGE" }
    };

    // Base64 Encode
    const payloadBase64 = Buffer.from(JSON.stringify(paymentData)).toString("base64");
    
    // Generate Checksum
    const checksum = generateChecksum(payloadBase64, "/pg/v1/pay");

    // PhonePe API Call
    const response = await axios.post(PHONEPE_BASE_URL, 
      { request: payloadBase64 },
      {
        headers: {
          "Content-Type": "application/json",
          "X-VERIFY": checksum,
        }
      }
    );

    // Validate Response
    if(!response.data?.data?.instrumentResponse?.redirectInfo?.url) {
      throw new Error("Invalid response from PhonePe API");
    }

    // Save Initial Transaction
    await supabase.from("transactions").insert({
      transaction_id: transactionId,
      amount: amount,
      status: "INITIATED",
      user_email: email
    });

    res.json({
      success: true,
      paymentUrl: response.data.data.instrumentResponse.redirectInfo.url
    });

  } catch (error) {
    console.error("Order Creation Error:", error);
    res.status(500).json({ 
      success: false,
      error: error.message || "Payment initiation failed"
    });
  }
});

// 2. Payment Callback Handler
app.post("/payment/callback", async (req, res) => {
  try {
    // Decode PhonePe Response
    const base64Response = req.body.response;
    if (!base64Response) throw new Error("Empty callback received");
    
    const decodedResponse = JSON.parse(
      Buffer.from(base64Response, "base64").toString("utf-8")
    );
    
    const transactionId = decodedResponse.data.merchantTransactionId;
    if (!transactionId) throw new Error("Transaction ID missing");

    // Verify Payment Status
    const checksum = generateChecksum("", `/pg/v1/status/${MERCHANT_ID}/${transactionId}`);
    const statusResponse = await axios.get(
      `${PHONEPE_STATUS_URL}/${MERCHANT_ID}/${transactionId}`,
      {
        headers: {
          "X-VERIFY": checksum,
          "X-MERCHANT-ID": MERCHANT_ID
        }
      }
    );

    // Update Database
    if (statusResponse.data.success) {
      const payment = statusResponse.data.data;
      
      await supabase.from("transactions").update({
        status: payment.state,
        payment_method: payment.paymentInstrument.type,
        transaction_time: new Date().toISOString()
      }).eq("transaction_id", transactionId);

      // Redirect to Success Page
      res.redirect(`/payment/success?transaction_id=${transactionId}`);
    } else {
      await supabase.from("transactions").update({
        status: "FAILED"
      }).eq("transaction_id", transactionId);
      
      res.redirect("/payment/failed");
    }

  } catch (error) {
    console.error("Callback Error:", error);
    res.redirect("/payment/failed");
  }
});

// 3. Get Transaction Details
app.get("/api/transaction/:id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("transactions")
      .select("*")
      .eq("transaction_id", req.params.id)
      .single();

    if (error || !data) throw new Error("Transaction not found");
    res.json(data);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

// 4. Serve Static Pages
app.get("/payment/success", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "success.html"));
});

app.get("/payment/failed", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "failed.html"));
});

// Start Server
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`PhonePe Integration Ready | Merchant ID: ${MERCHANT_ID}`);
});
