import express from "express";
import axios from "axios";
import crypto from "crypto";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS Configuration
app.use(cors({
  origin: "https://uwcindia.in",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// PhonePe Configuration
const MERCHANT_ID = process.env.MERCHANT_ID;
const MERCHANT_KEY = process.env.MERCHANT_KEY;
const KEY_INDEX = 1;
const IS_PRODUCTION = process.env.NODE_ENV === "production";

const PHONEPE_BASE_URL = IS_PRODUCTION
  ? "https://api.phonepe.com/apis/hermes"
  : "https://api-preprod.phonepe.com/apis/merchant-simulator";

// Supabase Configuration
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Helper Functions
const generateChecksum = (payload, endpoint) => {
  const string = payload + endpoint + MERCHANT_KEY;
  const sha256 = crypto.createHash("sha256").update(string).digest("hex");
  return `${sha256}###${KEY_INDEX}`;
};

const validatePhonePeResponse = (response) => {
  if (!response?.data?.success) return false;
  if (!response.data.data?.instrumentResponse?.redirectInfo?.url) return false;
  return true;
};

// Routes
app.post("/create-order", async (req, res) => {
  try {
    // Validate Input
    const { name, mobileNumber, amount, email, address, service_type } = req.body;
    if (!name || !mobileNumber || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Create Order ID
    const orderId = uuidv4();
    
    // Prepare Payment Payload
    const paymentPayload = {
      merchantId: MERCHANT_ID,
      merchantTransactionId: orderId,
      merchantUserId: name.substring(0, 36), // PhonePe max length
      amount: Math.round(Number(amount) * 100), // Convert to paisa
      currency: "INR",
      redirectUrl: "https://backend-uwc.onrender.com/payment-success",
      redirectMode: "POST",
      mobileNumber: mobileNumber.toString().padStart(10, '0').slice(-10),
      paymentInstrument: { type: "PAY_PAGE" }
    };

    // Generate Checksum
    const payloadBase64 = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    const checksum = generateChecksum(payloadBase64, "/pg/v1/pay");

    // Call PhonePe API
    const response = await axios.post(
      `${PHONEPE_BASE_URL}/pg/v1/pay`,
      { request: payloadBase64 },
      {
        headers: {
          "Content-Type": "application/json",
          "X-VERIFY": checksum,
        },
        timeout: 10000
      }
    );

    // Validate Response
    if (!validatePhonePeResponse(response)) {
      throw new Error("Invalid response from payment gateway");
    }

    // Save to Database
    const { error } = await supabase.from("orders").insert([{
      order_id: orderId,
      name,
      email: email || null,
      phone_no: mobileNumber,
      address: address || null,
      service_type: service_type || null,
      amount: Number(amount),
      status: "INITIATED",
      created_at: new Date().toISOString()
    }]);

    if (error) throw error;

    // Return Payment URL
    res.json({
      success: true,
      paymentUrl: response.data.data.instrumentResponse.redirectInfo.url
    });

  } catch (error) {
    console.error("Create Order Error:", {
      message: error.message,
      stack: error.stack,
      response: error.response?.data
    });
    
    res.status(500).json({
      success: false,
      error: "Payment initiation failed",
      debugId: uuidv4()
    });
  }
});

app.post("/payment-success", async (req, res) => {
  try {
    // Get Transaction ID
    const transactionId = req.body.transactionId || req.body.merchantTransactionId;
    if (!transactionId) {
      return res.redirect(`https://uwcindia.in/payment-failed?error=missing_transaction`);
    }

    // Verify Payment Status
    const checksum = generateChecksum("", `/pg/v1/status/${MERCHANT_ID}/${transactionId}`);
    const statusResponse = await axios.get(
      `${PHONEPE_BASE_URL}/pg/v1/status/${MERCHANT_ID}/${transactionId}`,
      {
        headers: {
          "X-VERIFY": checksum,
          "X-MERCHANT-ID": MERCHANT_ID
        }
      }
    );

    // Update Database
    if (statusResponse.data?.success) {
      const paymentData = statusResponse.data.data;
      
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

      return res.redirect(`https://uwcindia.in/payment-success?order_id=${transactionId}`);
    }

    throw new Error("Payment verification failed");

  } catch (error) {
    console.error("Payment Callback Error:", error);
    res.redirect(`https://uwcindia.in/payment-failed?error=${encodeURIComponent(error.message)}`);
  }
});

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
        amount: data.amount / 100 // Convert back to INR
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
