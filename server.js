import express from "express";
import axios from "axios";
import crypto from "crypto";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Enhanced CORS configuration
app.use(cors({
  origin: "https://uwcindia.in",
  methods: ["GET", "POST"],
  credentials: true
}));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// PhonePe configuration
const MERCHANT_ID = process.env.MERCHANT_ID;
const MERCHANT_KEY = process.env.MERCHANT_KEY;
const KEY_INDEX = 1;
const PHONEPE_BASE_URL = process.env.NODE_ENV === "production" 
  ? "https://api.phonepe.com/apis/hermes"
  : "https://api-preprod.phonepe.com/apis/merchant-simulator";

// Frontend URLs
const FRONTEND_SUCCESS_URL = "https://uwcindia.in/payment-success";
const FRONTEND_FAILURE_URL = "https://uwcindia.in/payment-failed";

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Helper functions
const generateChecksum = (payload, endpoint) => {
  const string = payload + endpoint + MERCHANT_KEY;
  return crypto.createHash("sha256").update(string).digest("hex") + "###" + KEY_INDEX;
};

// Create order endpoint
app.post("/create-order", async (req, res) => {
  try {
    const { name, mobileNumber, amount, email, address, service_type } = req.body;

    // Validation
    if (!name || !mobileNumber || !amount || !service_type) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const orderId = uuidv4();
    const amountInPaisa = Math.round(Number(amount) * 100;

    // Create PhonePe payload
    const paymentPayload = {
      merchantId: MERCHANT_ID,
      merchantTransactionId: orderId,
      merchantUserId: name.substring(0, 36),
      amount: amountInPaisa,
      currency: "INR",
      redirectUrl: `${PHONEPE_BASE_URL}/payment-success`,
      redirectMode: "POST",
      mobileNumber: mobileNumber.toString().slice(-10),
      paymentInstrument: { type: "PAY_PAGE" }
    };

    // Generate checksum
    const payloadBase64 = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    const checksum = generateChecksum(payloadBase64, "/pg/v1/pay");

    // Initiate PhonePe payment
    const response = await axios.post(
      `${PHONEPE_BASE_URL}/pg/v1/pay`,
      { request: payloadBase64 },
      {
        headers: {
          "Content-Type": "application/json",
          "X-VERIFY": checksum
        },
        timeout: 10000
      }
    );

    // Validate response
    if (!response?.data?.data?.instrumentResponse?.redirectInfo?.url) {
      throw new Error("Invalid response from payment gateway");
    }

    // Store order in Supabase
    const { error } = await supabase.from("orders").insert([{
      order_id: orderId,
      name,
      email,
      phone_no: mobileNumber,
      address,
      service_type,
      amount: Number(amount),
      status: "PENDING",
      created_at: new Date().toISOString()
    }]);

    if (error) throw error;

    // Return payment URL
    res.json({
      success: true,
      paymentUrl: response.data.data.instrumentResponse.redirectInfo.url
    });

  } catch (error) {
    console.error("Create Order Error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      debugId: uuidv4()
    });
  }
});

// Payment callback handler
app.post("/payment-success", async (req, res) => {
  try {
    const transactionId = req.body.transactionId || req.body.merchantTransactionId;
    
    if (!transactionId) {
      return res.redirect(`${FRONTEND_FAILURE_URL}?error=missing_transaction`);
    }

    // Verify payment status
    const checksumPayload = `${MERCHANT_ID}/pg/v1/status/${MERCHANT_ID}/${transactionId}`;
    const checksum = generateChecksum(checksumPayload, "");
    
    const statusResponse = await axios.get(
      `${PHONEPE_BASE_URL}/pg/v1/status/${MERCHANT_ID}/${transactionId}`,
      {
        headers: {
          "X-VERIFY": checksum,
          "X-MERCHANT-ID": MERCHANT_ID
        },
        timeout: 10000
      }
    );

    if (statusResponse.data?.success) {
      const paymentData = statusResponse.data.data;

      // Update order status
      const { error } = await supabase
        .from("orders")
        .update({
          status: paymentData.state,
          transaction_id: paymentData.transactionId,
          payment_method: paymentData.paymentInstrument?.type,
          updated_at: new Date().toISOString()
        })
        .eq("order_id", transactionId);

      if (error) throw error;

      // Redirect to frontend with order ID
      return res.redirect(`${FRONTEND_SUCCESS_URL}?order_id=${transactionId}`);
    }

    throw new Error("Payment verification failed");

  } catch (error) {
    console.error("Payment Callback Error:", error);
    res.redirect(`${FRONTEND_FAILURE_URL}?error=${encodeURIComponent(error.message)}`);
  }
});

// Get order details
app.get("/order/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("order_id", id)
      .single();

    if (error || !data) throw new Error("Order not found");

    res.json({
      success: true,
      data: {
        ...data,
        amount: data.amount / 100  // Convert back to INR
      }
    });

  } catch (error) {
    res.status(404).json({ 
      success: false,
      error: error.message 
    });
  }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
