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

// Enhanced CORS configuration
app.use(cors({
  origin: ["https://uwcindia.in", "https://backend-uwc.onrender.com"],
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

const MERCHANT_ID = process.env.MERCHANT_ID;
const MERCHANT_KEY = process.env.MERCHANT_KEY;
const KEY_INDEX = 1;

const MERCHANT_BASE_URL = "https://api.phonepe.com/apis/hermes/pg/v1/pay";
const MERCHANT_STATUS_URL = "https://api.phonepe.com/apis/hermes/pg/v1/status";

const FRONTEND_SUCCESS_URL = "https://uwcindia.in/payment-success";
const FRONTEND_FAILURE_URL = "https://uwcindia.in/payment-failed";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const generateChecksum = (payload, endpoint) => {
  const string = payload + endpoint + MERCHANT_KEY;
  const sha256 = crypto.createHash("sha256").update(string).digest("hex");
  return sha256 + "###" + KEY_INDEX;
};

// Create Order Endpoint
app.post("/create-order", async (req, res) => {
  try {
    const { name, mobileNumber, amount, email, address, service_type } = req.body;

    if (!name || !mobileNumber || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const orderId = uuidv4();
    const paymentPayload = {
      merchantId: MERCHANT_ID,
      merchantUserId: name,
      mobileNumber,
      amount: Number(amount) * 100,
      currency: "INR",
      merchantTransactionId: orderId,
      redirectUrl: "https://backend-uwc.onrender.com/payment-success",
      redirectMode: "POST",
      paymentInstrument: { type: "PAY_PAGE" },
    };

    const payload = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    const checksum = generateChecksum(payload, "/pg/v1/pay");

    const response = await axios.post(
      MERCHANT_BASE_URL,
      { request: payload },
      {
        headers: {
          "Content-Type": "application/json",
          "X-VERIFY": checksum,
        },
      }
    );

    if (response.data.success) {
      const { error } = await supabase.from("orders").insert([{
        order_id: orderId,
        name,
        email: email || "",
        phone_no: mobileNumber,
        address: address || "",
        service_type: service_type || "",
        amount: Number(amount),
        status: "PENDING",
        created_at: new Date().toISOString(),
      }]);

      if (error) throw error;

      return res.json({
        success: true,
        paymentUrl: response.data.data.instrumentResponse.redirectInfo.url
      });
    }
    
    throw new Error("Payment initiation failed");
  } catch (error) {
    console.error("Create Order Error:", error);
    return res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Payment Success Callback
app.post("/payment-success", async (req, res) => {
  try {
    const merchantTransactionId = req.body.transactionId || 
                                 req.body.merchantTransactionId || 
                                 req.query.id;

    if (!merchantTransactionId) {
      return res.redirect(`${FRONTEND_FAILURE_URL}?error=missing_transaction_id`);
    }

    // Verify payment status
    const checksum = generateChecksum(
      "",
      `/pg/v1/status/${MERCHANT_ID}/${merchantTransactionId}`
    );

    const statusResponse = await axios.get(
      `${MERCHANT_STATUS_URL}/${MERCHANT_ID}/${merchantTransactionId}`,
      {
        headers: {
          "X-VERIFY": checksum,
          "X-MERCHANT-ID": MERCHANT_ID,
        },
      }
    );

    if (statusResponse.data.success) {
      const paymentData = statusResponse.data.data;

      // Update order status
      const { error } = await supabase
        .from("orders")
        .update({
          status: paymentData.state,
          transaction_id: paymentData.transactionId,
          payment_method: paymentData.paymentInstrument.type,
          updated_at: new Date().toISOString()
        })
        .eq("order_id", merchantTransactionId);

      if (error) throw error;

      // Redirect to frontend with order ID
      return res.redirect(`${FRONTEND_SUCCESS_URL}?order_id=${merchantTransactionId}`);
    }

    return res.redirect(FRONTEND_FAILURE_URL);
  } catch (error) {
    console.error("Payment Success Error:", error);
    return res.redirect(
      `${FRONTEND_FAILURE_URL}?error=${encodeURIComponent(error.message)}`
    );
  }
});

// Get Order Details
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
        // Convert amount back to rupees
        amount: data.amount / 100
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
