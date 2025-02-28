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

// Middleware
app.use(cors());
app.use(express.json());

// PhonePe Configuration
const MERCHANT_ID = process.env.MERCHANT_ID || "M22PU06UWBZNO";
const MERCHANT_KEY = process.env.MERCHANT_KEY || "b3ac0315-843a-4560-9e49-118b67de175c";
const KEY_INDEX = 1;
const MERCHANT_BASE_URL = process.env.MERCHANT_BASE_URL || "https://api.phonepe.com/apis/hermes/pg/v1/pay";
const MERCHANT_STATUS_URL = process.env.MERCHANT_STATUS_URL || "https://api.phonepe.com/apis/hermes/pg/v1/status";
const redirectUrl = process.env.REDIRECT_URL || "https://backend-uwc.onrender.com/payment-success";
const successUrl = process.env.SUCCESS_URL || "https://uwcindia.in/payment-success";
const failureUrl = process.env.FAILURE_URL || "https://uwcindia.in/payment-failed";

// Supabase Client (if needed)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Checksum Generation
const generateChecksum = (payload, endpoint) => {
  const string = payload + endpoint + MERCHANT_KEY;
  return crypto.createHash("sha256").update(string).digest("hex") + "###" + KEY_INDEX;
};

// Create Order with UPI QR
app.post("/create-order", async (req, res) => {
  try {
    const { name, amount, mobileNumber } = req.body;
    const orderId = uuidv4();

    const paymentPayload = {
      merchantId: MERCHANT_ID,
      merchantUserId: name,
      mobileNumber,
      amount: Number(amount) * 100,
      currency: "INR",
      merchantTransactionId: orderId,
      redirectUrl: redirectUrl,
      paymentInstrument: {
        type: "UPI_QR" // UPI QR Code Type
      }
    };

    const payload = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    const checksum = generateChecksum(payload, "/pg/v1/pay");

    const response = await axios.post(
      MERCHANT_BASE_URL,
      { request: payload },
      {
        headers: {
          "accept": "application/json",
          "Content-Type": "application/json",
          "X-VERIFY": checksum
        }
      }
    );

    // Extract QR Code Data
    const qrData = response.data.data.instrumentResponse.qrData;

    res.json({
      success: true,
      qrCodeUrl: qrData,
      transactionId: orderId,
      phonepeResponse: response.data
    });

  } catch (error) {
    console.error("Payment Error:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data?.message || "Payment initiation failed"
    });
  }
});

// Payment Status Check
app.get("/payment-success", async (req, res) => {
  try {
    const { merchantTransactionId } = req.query;
    
    const statusPayload = {
      merchantId: MERCHANT_ID,
      merchantTransactionId
    };

    const payload = Buffer.from(JSON.stringify(statusPayload)).toString("base64");
    const checksum = generateChecksum(payload, `/pg/v1/status/${MERCHANT_ID}/${merchantTransactionId}`);

    const response = await axios.get(
      `${MERCHANT_STATUS_URL}/${MERCHANT_ID}/${merchantTransactionId}`,
      {
        headers: {
          "accept": "application/json",
          "Content-Type": "application/json",
          "X-VERIFY": checksum,
          "X-MERCHANT-ID": MERCHANT_ID
        }
      }
    );

    if (response.data.code === "PAYMENT_SUCCESS") {
      res.redirect(successUrl);
    } else {
      res.redirect(failureUrl);
    }
    
  } catch (error) {
    console.error("Status Check Error:", error.response?.data || error.message);
    res.redirect(failureUrl);
  }
});

// Server Start
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log("PhonePe Config:", {
    merchantId: MERCHANT_ID,
    baseUrl: MERCHANT_BASE_URL
  });
});
