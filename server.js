import express from "express";
import crypto from "crypto";
import cors from "cors";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const port = process.env.PORT || 8000;

app.use(express.json());
app.use(cors());

// Supabase Configuration (Production)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// PhonePe Production Config
const PHONEPE_CONFIG = {
  merchantId: process.env.MERCHANT_ID,
  saltKey: process.env.PHONEPE_SALT_KEY,
  saltIndex: process.env.PHONEPE_SALT_INDEX,
  baseUrl: "https://api.phonepe.com/apis/hermes" // Production URL
};

// Generate Transaction ID
const generateTxnId = () => `TXN${Date.now()}${Math.floor(Math.random() * 1000)}`;

// Save to Orders Table
const saveOrderToSupabase = async (orderData) => {
  const { data, error } = await supabase
    .from("orders")
    .insert([orderData])
    .select();

  if (error) throw new Error("Supabase save failed");
  return data[0];
};

// Create Order Endpoint
app.post("/create-order", async (req, res) => {
  try {
    const { name, email, phone, address, serviceType, amount } = req.body;

    // 1. Create Transaction Record
    const txnId = generateTxnId();
    const orderData = {
      txn_id: txnId,
      name,
      email,
      phone,
      address,
      service_type: serviceType,
      amount,
      status: "PENDING",
      created_at: new Date().toISOString()
    };

    // 2. Save to Supabase Before Payment
    await saveOrderToSupabase(orderData);

    // 3. Prepare PhonePe Payment
    const paymentPayload = {
      merchantId: PHONEPE_CONFIG.merchantId,
      merchantTransactionId: txnId,
      amount: amount * 100,
      merchantUserId: phone,
      redirectUrl: `${process.env.BASE_URL}/payment/success?txn_id=${txnId}`,
      redirectMode: "POST",
      paymentInstrument: { type: "PAY_PAGE" }
    };

    // 4. Generate Checksum
    const base64Payload = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    const checksumString = `/pg/v1/pay${base64Payload}${PHONEPE_CONFIG.saltKey}`;
    const checksum = crypto.createHash("sha256").update(checksumString).digest("hex");

    // 5. Initiate Payment
    const response = await fetch(`${PHONEPE_CONFIG.baseUrl}/pg/v1/pay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-VERIFY": `${checksum}###${PHONEPE_CONFIG.saltIndex}`
      },
      body: JSON.stringify({ request: base64Payload })
    });

    const result = await response.json();
    
    res.json({
      success: true,
      url: result.data.instrumentResponse.redirectInfo.url
    });

  } catch (error) {
    console.error("Payment Error:", error);
    res.status(500).json({ 
      success: false,
      message: error.response?.data?.message || "Payment failed" 
    });
  }
});

// Payment Success Handler
app.get("/payment/success", async (req, res) => {
  const { txn_id } = req.query;
  
  // Update Order Status
  await supabase
    .from("orders")
    .update({ status: "SUCCESS" })
    .eq("txn_id", txn_id);

  // Redirect to Beautiful Success Page
  res.redirect(`${process.env.FRONTEND_URL}/success?txn_id=${txn_id}`);
});

// Payment Failure Handler
app.get("/payment/failure", async (req, res) => {
  const { txn_id } = req.query;
  
  await supabase
    .from("orders")
    .update({ status: "FAILED" })
    .eq("txn_id", txn_id);

  res.redirect(`${process.env.FRONTEND_URL}/failure?txn_id=${txn_id}`);
});

app.listen(port, () => console.log(`🚀 Production Server running on port ${port}`));
