import express from "express";
import axios from "axios";
import crypto from "crypto";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { createClient } from "@supabase/supabase-js"; // ✅ Correct package name
const app = express();
const port = 8000;

app.use(express.json());
app.use(cors({ origin: "https://uwcindia.in" }));

// Supabase Config
const supabase = createClient(
  "https://pvtuhceijltezxhqibrv.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB2dHVoY2Vpamx0ZXp4aHFpYnJ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Mzk0Njk1MzMsImV4cCI6MjA1NTA0NTUzM30.kw49U2pX09mV9AjqqPMbipv2Dv6aSttqCXHhJQlmisY"
);

// ✅ Cashfree Production Config
const CASHFREE_APP_ID = "CF33963763787EA2F26F0FE1AF9E736939"; // Production App ID
const CASHFREE_SECRET_KEY = "cfsk_ma_prod_25a32122a99a0240c0653d9d12f0e985_a44c9fcf";
const CASHFREE_BASE_URL = "https://api.cashfree.com/pg"; // Production URL

// ✅ Fixed Signature Generation with Timestamp
const generateCashfreeSignature = (orderId, amount, secret) => {
  const timestamp = new Date().toISOString();
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

    // ✅ Production-ready Payment Payload
   const paymentPayload = {
  payment_session_id: uuidv4(),
  order_id: orderId,
  order_amount: Math.round(Number(amount) * 100), // ✅ Fixed parenthesis
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

    // ✅ Generate proper signature
    const { signature, timestamp } = generateCashfreeSignature(
      paymentPayload.order_id,
      paymentPayload.order_amount,
      CASHFREE_SECRET_KEY
    );

    // ✅ Production API Call with Security Headers
    const cashfreeResponse = await axios.post(
      `${CASHFREE_BASE_URL}/orders`,
      paymentPayload,
      {
        headers: {
          "x-client-id": CASHFREE_APP_ID,
          "x-client-secret": CASHFREE_SECRET_KEY,
          "x-api-version": "2022-09-01",
          "x-cf-signature": signature,
          "x-cf-timestamp": timestamp,
          "Content-Type": "application/json"
        }
      }
    );

    // ✅ Enhanced Error Logging
    if (!cashfreeResponse.data.payment_link) {
      throw new Error("Cashfree payment link not generated");
    }

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
      transaction_id: paymentPayload.payment_session_id,
      created_at: new Date().toISOString()
    }]);

    if (error) throw error;

    res.json({
      url: cashfreeResponse.data.payment_link,
      txnId: paymentPayload.payment_session_id
    });

  } catch (error) {
    console.error("Production Payment Error:", {
      message: error.message,
      response: error.response?.data,
      stack: error.stack
    });
    res.status(500).json({
      error: "Payment processing failed",
      code: "PAYMENT_GATEWAY_ERROR",
      referenceId: uuidv4()
    });
  }
});

// Payment Success Endpoint (Production Optimized)
app.post("/payment-success", async (req, res) => {
  try {
    // ✅ Verify Cashfree Webhook Signature
    const signature = req.headers['x-cf-signature'];
    const receivedData = JSON.stringify(req.body);
    const expectedSignature = crypto
      .createHash('sha256')
      .update(receivedData + CASHFREE_SECRET_KEY)
      .digest('hex');

    if (signature !== expectedSignature) {
      throw new Error("Invalid webhook signature");
    }

    const { order_id, payment_status } = req.body;
    
    // Update database
    const { data, error } = await supabase
      .from("orders")
      .update({
        payment_status: payment_status === "SUCCESS" ? "SUCCESS" : "FAILED",
        updated_at: new Date().toISOString()
      })
      .eq("order_id", order_id);

    if (error) throw error;

    res.status(200).send("Webhook processed");
    
  } catch (error) {
    console.error("Production Webhook Error:", error);
    res.status(400).send("Webhook processing failed");
  }
});

app.listen(port, () => console.log(`Production server running on port ${port}`));
