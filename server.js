import express from "express";
import crypto from "crypto";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const port = process.env.PORT || 8000;

app.use(express.json());
app.use(cors());

// Supabase Configuration
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// PhonePe Configuration
const PHONEPE_CONFIG = {
  merchantId: process.env.MERCHANT_ID,
  saltKey: process.env.PHONEPE_SALT_KEY,
  saltIndex: process.env.PHONEPE_SALT_INDEX,
  baseUrl: "https://api-preprod.phonepe.com/apis/pg-sandbox"
};

// Generate Transaction ID
const generateTxnId = () => `TXN${Date.now()}${Math.floor(Math.random() * 1000)}`;

// Save to Orders Table
const saveOrderToSupabase = async (orderData) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .insert([orderData])
      .select();

    if (error) throw error;
    return data[0];
  } catch (error) {
    console.error('Supabase Error:', error);
    throw error;
  }
};

// Create Order Endpoint
app.post("/create-order", async (req, res) => {
  try {
    const { name, email, phone, address, service_type, amount } = req.body;

    // Validate input
    if (!name || !email || !phone || !address || !amount) {
      return res.status(400).json({ error: "All fields are required" });
    }

    // Create transaction data
    const txnId = generateTxnId();
    const orderData = {
      txn_id: txnId,
      name,
      email,
      phone,
      address,
      service_type,
      amount,
      status: "PENDING",
      created_at: new Date().toISOString()
    };

    // Save to Supabase
    await saveOrderToSupabase(orderData);

    // Prepare PhonePe payload
    const paymentPayload = {
      merchantId: PHONEPE_CONFIG.merchantId,
      merchantTransactionId: txnId,
      amount: amount * 100,
      merchantUserId: `USER_${phone}`,
      redirectUrl: `${process.env.BASE_URL}/payment/success?txn_id=${txnId}`,
      redirectMode: "POST",
      paymentInstrument: { type: "PAY_PAGE" }
    };

    // Generate checksum
    const base64Payload = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    const checksumString = `/pg/v1/pay${base64Payload}${PHONEPE_CONFIG.saltKey}`;
    const checksum = crypto
      .createHmac('sha256', PHONEPE_CONFIG.saltKey)
      .update(checksumString)
      .digest('hex');

    // Initiate payment
    const response = await fetch(`${PHONEPE_CONFIG.baseUrl}/pg/v1/pay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-VERIFY": `${checksum}###${PHONEPE_CONFIG.saltIndex}`
      },
      body: JSON.stringify({ request: base64Payload })
    });

    const result = await response.json();

    if (!result.data?.instrumentResponse?.redirectInfo?.url) {
      throw new Error("Payment gateway error");
    }

    res.json({
      success: true,
      url: result.data.instrumentResponse.redirectInfo.url,
      txnId
    });

  } catch (error) {
    console.error("Payment Error:", error);
    res.status(500).json({ 
      error: error.message || "Payment initialization failed",
      code: "PAYMENT_ERROR"
    });
  }
});

// Payment Success Webhook
app.post("/payment/success", async (req, res) => {
  try {
    const { txn_id } = req.query;
    const paymentData = req.body;

    // Update order status
    const { error } = await supabase
      .from('orders')
      .update({ 
        status: "SUCCESS",
        payment_details: paymentData,
        updated_at: new Date().toISOString()
      })
      .eq('txn_id', txn_id);

    if (error) throw error;

    res.redirect(`${process.env.FRONTEND_URL}/success?txn_id=${txn_id}`);

  } catch (error) {
    console.error("Webhook Error:", error);
    res.redirect(`${process.env.FRONTEND_URL}/error`);
  }
});

app.listen(port, () => console.log(`Server running on port ${port}`));
