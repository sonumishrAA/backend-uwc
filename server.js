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
const PHONEPE_BASE_URL = "https://api.phonepe.com/apis/hermes";

// Helper functions
const generateChecksum = (payload, endpoint) => {
  const string = payload + endpoint + MERCHANT_KEY;
  const sha256 = crypto.createHash("sha256").update(string).digest("hex");
  return sha256 + "###" + KEY_INDEX;
};

// Create Order Endpoint
app.post("/create-order", async (req, res) => {
  try {
    const { name, mobileNumber, amount, email, address, service_type } = req.body;

    // Validation
    if (!name || !mobileNumber || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    if (amount < 1) return res.status(400).json({ error: "Minimum amount is ₹1" });

    const orderId = uuidv4();
    const paymentPayload = {
      merchantId: MERCHANT_ID,
      merchantUserId: name,
      mobileNumber,
      amount: Math.round(amount * 100),
      currency: "INR",
      merchantTransactionId: orderId,
      redirectUrl: `${process.env.BACKEND_URL}/payment-success`,
      redirectMode: "POST",
      paymentInstrument: { type: "PAY_PAGE" },
    };

    // Generate PhonePe request
    const base64Payload = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    const checksum = generateChecksum(base64Payload, "/pg/v1/pay");

    // Initiate payment
    const response = await axios.post(
      `${PHONEPE_BASE_URL}/pg/v1/pay`,
      { request: base64Payload },
      {
        headers: {
          "Content-Type": "application/json",
          "X-VERIFY": checksum,
        },
      }
    );

    // Save to Supabase
    const { error } = await supabase.from("orders").insert([
      {
        order_id: orderId,
        name,
        email,
        phone_no: mobileNumber,
        address,
        service_type,
        amount: Number(amount),
        status: "PENDING",
        created_at: new Date().toISOString(),
      },
    ]);

    if (error) throw error;

    res.json({
      success: true,
      url: response.data.data.instrumentResponse.redirectInfo.url,
      orderId,
    });
  } catch (error) {
    console.error("Create Order Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Payment Success Webhook
app.post("/payment-success", async (req, res) => {
  try {
    const { transactionId } = req.body;
    const orderId = transactionId || req.query.orderId;

    if (!orderId) {
      return res.redirect(`${process.env.FRONTEND_FAILURE_URL}?error=missing_order_id`);
    }

    // Verify payment status with PhonePe
    const checksum = generateChecksum("", `/pg/v1/status/${MERCHANT_ID}/${orderId}`);
    const statusResponse = await axios.get(
      `${PHONEPE_BASE_URL}/pg/v1/status/${MERCHANT_ID}/${orderId}`,
      {
        headers: {
          "X-VERIFY": checksum,
          "X-MERCHANT-ID": MERCHANT_ID,
        },
      }
    );

    if (statusResponse.data.success) {
      const paymentData = statusResponse.data.data;

      // Update order in Supabase
      const { error } = await supabase
        .from("orders")
        .update({
          status: paymentData.state,
          transaction_id: paymentData.transactionId,
          payment_method: paymentData.paymentInstrument.type,
          updated_at: new Date().toISOString(),
        })
        .eq("order_id", orderId);

      if (error) throw error;

      return res.redirect(`${process.env.FRONTEND_SUCCESS_URL}/${orderId}`);
    }

    res.redirect(process.env.FRONTEND_FAILURE_URL);
  } catch (error) {
    console.error("Payment Success Error:", error);
    res.redirect(
      `${process.env.FRONTEND_FAILURE_URL}?error=${encodeURIComponent(error.message)}`
    );
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
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
