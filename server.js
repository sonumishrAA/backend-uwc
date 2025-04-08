import express from "express";
import axios from "axios";
import crypto from "crypto";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { createClient } from "@supabase/supabase-js";

const app = express();
const port = 8000;

app.use(express.json());
app.use(cors({ origin: "https://uwcindia.in" }));

// Supabase Config
const supabase = createClient(
  "https://pvtuhceijltezxhqibrv.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB2dHVoY2Vpamx0ZXp4aHFpYnJ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Mzk0Njk1MzMsImV4cCI6MjA1NTA0NTUzM30.kw49U2pX09mV9AjqqPMbipv2Dv6aSttqCXHhJQlmisY"
);

// Cashfree Configuration
const CASHFREE_CONFIG = {
  APP_ID: "CF33963763787EA2F26F0FE1AF9E736939",
  SECRET_KEY: "cfsk_pg_prod_25a32122a99a0240c0653d9d12f0e985_a44c9fcf",
  BASE_URL: "https://api.cashfree.com/pg",
  API_VERSION: "2022-09-01"
};

// Signature Generation
const generateCashfreeSignature = (orderId, amount, secret) => {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signatureData = `${orderId}${amount}${timestamp}${secret}`;
  return {
    signature: crypto.createHash('sha256').update(signatureData).digest('hex'),
    timestamp
  };
};

// Order Creation Endpoint
app.post("/create-order", async (req, res) => {
  try {
    const { email, name, mobileNumber, amount, address, service_type } = req.body;
    const orderId = `ORDER_${uuidv4()}`;
  const orderAmount = Math.round(Number(amount) * 100);


   if (isNaN(orderAmount)) throw new Error("Invalid amount");

    const paymentPayload = {
      order_id: orderId,
      order_amount: orderAmount,
      order_currency: "INR",
      customer_details: {
        customer_id: `CUST_${mobileNumber.slice(-4)}`,
        customer_phone: mobileNumber,
        customer_name: name,
        customer_email: email
      },
      order_meta: {
        return_url: "https://uwcindia.in/success?order_id={order_id}"
      }
    };

    const { signature, timestamp } = generateCashfreeSignature(
      orderId,
      orderAmount,
      CASHFREE_CONFIG.SECRET_KEY
    );

    const headers = {
      "x-client-id": CASHFREE_CONFIG.APP_ID,
      "x-client-secret": CASHFREE_CONFIG.SECRET_KEY, // Added missing secret
      "x-api-version": CASHFREE_CONFIG.API_VERSION,
      "x-cf-signature": signature,
      "x-cf-timestamp": timestamp,
      "Content-Type": "application/json"
    };

    const cashfreeResponse = await axios.post(
      `${CASHFREE_CONFIG.BASE_URL}/orders`,
      paymentPayload,
      { headers }
    );

    // Supabase Insert
    const { error } = await supabase.from("orders").insert([{
      order_id: orderId,
      email,
      name,
      phone_no: mobileNumber,
      amount: Number(amount),
      address,
      service_type,
      payment_status: "INITIATED",
      created_at: new Date().toISOString()
    }]);

    if (error) throw error;

    res.json({
      url: cashfreeResponse.data.payment_link,
      txnId: orderId
    });

  } catch (error) {
    console.error("Payment Error:", error.response?.data || error.message);
    res.status(500).json({
      error: error.response?.data?.message || "Payment processing failed",
      code: "PAYMENT_ERROR"
    });
  }
});

// Webhook Handler
app.post("/payment-webhook", async (req, res) => {
  try {
    const receivedSignature = req.headers['x-cf-signature'];
    const body = JSON.stringify(req.body);
    
    const generatedSignature = crypto
      .createHash('sha256')
      .update(body + CASHFREE_CONFIG.SECRET_KEY)
      .digest('hex');

    if (receivedSignature !== generatedSignature) {
      return res.status(403).json({ error: "Invalid signature" });
    }

    const { order_id, payment_status } = req.body;
    
    await supabase
      .from("orders")
      .update({ 
        payment_status: payment_status === "SUCCESS" ? "SUCCESS" : "FAILED",
        updated_at: new Date().toISOString()
      })
      .eq("order_id", order_id);

    res.status(200).json({ status: "Webhook processed" });

  } catch (error) {
    console.error("Webhook Error:", error);
    res.status(400).json({ error: "Webhook processing failed" });
  }
});

app.listen(port, () => console.log(`Server running on port ${port}`));
