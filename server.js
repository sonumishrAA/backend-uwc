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

// Supabase Configuration
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// PhonePe Configuration
const PHONEPE_CONFIG = {
  merchantId: process.env.MERCHANT_ID,
  saltKey: process.env.PHONEPE_SALT_KEY,
  saltIndex: process.env.PHONEPE_SALT_INDEX || 1,
  baseUrl: "https://api.phonepe.com/apis/hermes"
};

// Fixed Transaction ID Generation
const generateTxnId = () => 
  `TXN${Date.now()}${Math.floor(Math.random() * 9000 + 1000)}`;

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
    const { name, email, mobileNumber, address, service_type, amount } = req.body;

    // Validation
    if (amount < 1) {
      return res.status(400).json({ error: "Minimum amount is ₹1" });
    }

    // Create Transaction Data
    const txnId = generateTxnId();
    const orderData = {
      txn_id: txnId,
      name,
      email,
      phone: mobileNumber,
      address,
      service_type,
      amount,
      status: "PENDING",
      payment_details: null
    };

    // Save initial order data
    await saveOrderToSupabase(orderData);

    // Prepare PhonePe Payment
    const paymentPayload = {
      merchantId: PHONEPE_CONFIG.merchantId,
      merchantTransactionId: txnId,
      amount: amount * 100,
      merchantUserId: "CUSTOMER_"+mobileNumber,
      redirectUrl: `${process.env.BASE_URL}/payment/success`,
      redirectMode: "POST",
      callbackUrl: `${process.env.BASE_URL}/payment/callback`,
      paymentInstrument: { 
        type: "PAY_PAGE"
      }
    };

    // Generate Checksum
    const base64Payload = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    const checksumString = `/pg/v1/pay${base64Payload}${PHONEPE_CONFIG.saltKey}`;
    const checksum = crypto
      .createHmac('sha256', PHONEPE_CONFIG.saltKey)
      .update(checksumString)
      .digest('hex');

    // Initiate Payment
    const paymentResponse = await fetch(`${PHONEPE_CONFIG.baseUrl}/pg/v1/pay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-VERIFY": `${checksum}###${PHONEPE_CONFIG.saltIndex}`
      },
      body: JSON.stringify({ request: base64Payload })
    });

    const result = await paymentResponse.json();
    
    if (!result.data || !result.data.instrumentResponse) {
      console.error("PhonePe API Error:", result);
      throw new Error("Payment gateway response malformed");
    }

    res.json({
      success: true,
      url: result.data.instrumentResponse.redirectInfo.url
    });

  } catch (error) {
    console.error("Server Error:", error);
    res.status(500).json({
      error: error.message || "Payment initialization failed"
    });
  }
});

// Payment Success Webhook
app.post("/payment/success", async (req, res) => {
  try {
    const { txn_id, ...paymentData } = req.body;
    
    await supabase
      .from("orders")
      .update({ 
        status: "SUCCESS",
        payment_details: paymentData
      })
      .eq("txn_id", txn_id);

    res.redirect(`${process.env.FRONTEND_URL}/success?txn_id=${txn_id}`);
  } catch (error) {
    console.error("Payment Success Error:", error);
    res.redirect(`${process.env.FRONTEND_URL}/error`);
  }
});

app.listen(port, () => console.log(`Server running on port ${port}`));
