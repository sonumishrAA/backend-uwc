import express from "express";
import axios from "axios";
import crypto from "crypto";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const port = process.env.PORT || 8000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: process.env.FRONTEND_URL || "https://uwcindia.in" }));

// Supabase Configuration
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// PhonePe Configuration
const MERCHANT_ID = process.env.MERCHANT_ID;
const MERCHANT_KEY = process.env.MERCHANT_KEY;
const KEY_INDEX = process.env.KEY_INDEX || 1;
const PHONEPE_BASE_URL = process.env.PHONEPE_ENV === 'production' 
  ? "https://api.phonepe.com/apis/hermes" 
  : "https://api-preprod.phonepe.com/apis/pg-sandbox";

// Helper functions
const generateChecksum = (payload, endpoint) => {
  const string = Buffer.from(payload).toString('utf8') + endpoint + MERCHANT_KEY;
  return crypto.createHash("sha256").update(string).digest("hex") + "###" + KEY_INDEX;
};

// Create Order Endpoint
app.post("/create-order", async (req, res) => {
  try {
    const { name, mobileNumber, amount, email, address, service_type } = req.body;

    // Enhanced validation
    if (!name || !mobileNumber || !amount || !/^\d{10}$/.test(mobileNumber)) {
      return res.status(400).json({ error: "Invalid/Missing required fields" });
    }

    const orderId = uuidv4();
    const paymentPayload = {
      merchantId: MERCHANT_ID,
      merchantTransactionId: orderId,
      merchantUserId: `USER_${mobileNumber.slice(-4)}`,
      amount: Math.round(Number(amount) * 100), // Ensure numeric conversion
      currency: "INR",
      redirectUrl: `${process.env.BACKEND_URL}/payment-success`,
      redirectMode: "POST",
      mobileNumber: mobileNumber.toString(),
      paymentInstrument: { type: "PAY_PAGE" }
    };

    // Debug logs
    console.log("Payment Payload:", paymentPayload);
    
    const base64Payload = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    const checksum = generateChecksum(base64Payload, "/pg/v1/pay");
    console.log("Generated Checksum:", checksum);

    const response = await axios.post(
      `${PHONEPE_BASE_URL}/pg/v1/pay`,
      { request: base64Payload },
      {
        headers: {
          "Content-Type": "application/json",
          "X-VERIFY": checksum,
          "X-CALLBACK-URL": `${process.env.BACKEND_URL}/payment-success` // Some environments require this
        },
        timeout: 10000 // Add timeout
      }
    );

    if (!response.data?.data?.instrumentResponse?.redirectInfo?.url) {
      throw new Error("Invalid response from payment gateway");
    }

    // Save to Supabase
    const { error } = await supabase.from("orders").insert([{
      order_id: orderId,
      name,
      email,
      phone_no: mobileNumber,
      address,
      service_type,
      amount: Number(amount),
      status: "PENDING",
      created_at: new Date().toISOString(),
    }]);

    if (error) throw error;

    res.json({
      success: true,
      url: response.data.data.instrumentResponse.redirectInfo.url,
      orderId,
    });
  } catch (error) {
    console.error("Create Order Error:", error.response?.data || error.message);
    res.status(500).json({ 
      error: "Payment initiation failed",
      details: error.response?.data || error.message
    });
  }
});

// Payment Success Webhook
app.post("/payment-success", async (req, res) => {
  try {
    const { transactionId, merchantTransactionId } = req.body;
    const orderId = transactionId || merchantTransactionId || req.query.orderId;

    if (!orderId) {
      return res.redirect(`${process.env.FRONTEND_FAILURE_URL}?error=missing_order_id`);
    }

    // Enhanced checksum generation for status check
    const statusEndpoint = `/pg/v1/status/${MERCHANT_ID}/${orderId}`;
    const checksum = generateChecksum("", statusEndpoint);
    
    const statusResponse = await axios.get(
      `${PHONEPE_BASE_URL}${statusEndpoint}`,
      {
        headers: {
          "X-VERIFY": checksum,
          "X-MERCHANT-ID": MERCHANT_ID,
          "Content-Type": "application/json"
        },
        timeout: 10000
      }
    );

    if (statusResponse.data?.success) {
      const paymentData = statusResponse.data.data;
      
      // Update order in Supabase
      const { error } = await supabase
        .from("orders")
        .update({
          status: paymentData.state,
          transaction_id: paymentData.transactionId,
          payment_method: paymentData.paymentInstrument?.type || 'UNKNOWN',
          updated_at: new Date().toISOString(),
        })
        .eq("order_id", orderId);

      return res.redirect(`${process.env.FRONTEND_SUCCESS_URL}/${orderId}`);
    }

    res.redirect(process.env.FRONTEND_FAILURE_URL);
  } catch (error) {
    console.error("Payment Verification Error:", error.response?.data || error.message);
    res.redirect(`${process.env.FRONTEND_FAILURE_URL}?error=verification_failed`);
  }
});

// Order Status Check
app.get("/order/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("order_id", id)
      .single();

    if (error || !data) throw new Error("Order not found");
    res.json(data);
  } catch (error) {
    console.error("Order Fetch Error:", error);
    res.status(404).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
