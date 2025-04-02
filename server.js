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

// ✅ Cashfree PG Production Keys (NOT Master Keys)
const CASHFREE_APP_ID = "CF33963763787EA2F26F0FE1AF9E736939";
const CASHFREE_SECRET_KEY = "cfsk_pg_prod_25a32122a99a0240c0653d9d12f0e985_a44c9fcf"; // PG Key
const CASHFREE_BASE_URL = "https://api.cashfree.com/pg";

// ✅ Verified Signature Generation
const generateCashfreeSignature = (orderId, amount, secret) => {
  const timestamp = Math.floor(Date.now() / 1000).toString(); // Unix seconds as string
  const signatureData = `${orderId}${amount}${timestamp}${secret}`;
  return {
    signature: crypto.createHash('sha256').update(signatureData).digest('hex'),
    timestamp
  };
};

app.post("/create-order", async (req, res) => {
  try {
    const { email, name, mobileNumber, amount, address, service_type } = req.body;
    const orderId = `ORDER_${uuidv4()}`;

    // ✅ Validate Amount Conversion
    const orderAmount = Math.round(Number(amount) * 100);
    if (isNaN(orderAmount) || orderAmount < 100) {
      throw new Error("Invalid amount");
    }

    // Payment Payload
    const paymentPayload = {
      order_id: orderId,
      order_amount: orderAmount, // In paise
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

    // Generate Signature
    const { signature, timestamp } = generateCashfreeSignature(
      paymentPayload.order_id,
      paymentPayload.order_amount,
      CASHFREE_SECRET_KEY
    );

    // ✅ Debug Logs (Remove in production)
    console.log("Signature Data:", {
      orderId: paymentPayload.order_id,
      amount: paymentPayload.order_amount,
      timestamp,
      signature
    });

    // API Headers
    const headers = {
      "x-client-id": CASHFREE_APP_ID,
      "x-api-version": "2022-09-01",
      "x-cf-signature": signature,
      "x-cf-timestamp": timestamp,
      "Content-Type": "application/json"
    };

    // Cashfree API Call
    const cashfreeResponse = await axios.post(
      `${CASHFREE_BASE_URL}/orders`,
      paymentPayload,
      { headers }
    );

    // Validate Response
    if (!cashfreeResponse.data.payment_link) {
      throw new Error("Cashfree payment link not generated");
    }

    // Insert to Supabase
    const { error } = await supabase.from("orders").insert([{
      order_id: orderId,
      email,
      name,
      phone_no: mobileNumber,
      amount: Number(amount),
      address,
      service_type,
      payment_status: "INITIATED",
      transaction_id: paymentPayload.order_id,
      created_at: new Date().toISOString()
    }]);

    if (error) throw error;

    res.json({
      url: cashfreeResponse.data.payment_link,
      txnId: paymentPayload.order_id
    });

  } catch (error) {
    console.error("Payment Error:", {
      message: error.message,
      response: error.response?.data
    });
    res.status(500).json({
      error: error.response?.data?.message || "Payment processing failed",
      code: "PAYMENT_GATEWAY_ERROR"
    });
  }
});

// Webhook Endpoint
app.post("/payment-success", async (req, res) => {
  try {
    const signature = req.headers['x-cf-signature'];
    const body = JSON.stringify(req.body);
    
    // Verify Signature
    const expectedSignature = crypto
      .createHash('sha256')
      .update(body + CASHFREE_SECRET_KEY)
      .digest('hex');

    if (signature !== expectedSignature) {
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
