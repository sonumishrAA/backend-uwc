import express from "express";
import axios from "axios";
import crypto from "crypto";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MERCHANT_ID = process.env.MERCHANT_ID;
const MERCHANT_KEY = process.env.MERCHANT_KEY;
const PHONEPE_BASE_URL = process.env.PHONEPE_BASE_URL;
const FRONTEND_SUCCESS_URL = process.env.FRONTEND_SUCCESS_URL;
const FRONTEND_FAILURE_URL = process.env.FRONTEND_FAILURE_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// 🔹 Function to Generate Checksum
const generateChecksum = (payload, endpoint) => {
  const saltKey = MERCHANT_KEY;
  const fullString = payload + endpoint + saltKey;
  return crypto.createHash("sha256").update(fullString).digest("hex") + "###1";
};

// 🔥 **Order Creation (Before Payment)**
app.post("/create-order", async (req, res) => {
  try {
    const { order_id, name, phone_no, amount } = req.body;

    if (!order_id || !name || !phone_no || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // ✅ Insert Order in Supabase
    const { data, error } = await supabase.from("orders").insert([
      {
        order_id,
        name,
        phone_no,
        amount,
        status: "PENDING",
      },
    ]);

    if (error) throw error;
    res.json({ success: true, message: "Order Created Successfully", order_id });
  } catch (error) {
    console.error("Create Order Error:", error.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// 🔥 **Payment Success Webhook**
app.post("/payment-success", async (req, res) => {
  try {
    const { transactionId, merchantTransactionId } = req.body;
    const orderId = transactionId || merchantTransactionId || req.query.orderId;

    if (!orderId) {
      return res.redirect(`${FRONTEND_FAILURE_URL}?error=missing_order_id`);
    }

    const statusEndpoint = `/pg/v1/status/${MERCHANT_ID}/${orderId}`;
    const checksum = generateChecksum("", statusEndpoint);

    // 📌 **Check Payment Status from PhonePe**
    const statusResponse = await axios.get(`${PHONEPE_BASE_URL}${statusEndpoint}`, {
      headers: {
        "X-VERIFY": checksum,
        "X-MERCHANT-ID": MERCHANT_ID,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    });

    if (statusResponse.data?.success) {
      const paymentData = statusResponse.data.data;

      // ✅ **Update Payment Details in Supabase**
      const { error } = await supabase
        .from("orders")
        .update({
          status: paymentData.state, // PAID / FAILED / PENDING
          transaction_id: paymentData.transactionId,
          payment_method: paymentData.paymentInstrument?.type || "UNKNOWN",
          bank_name: paymentData.paymentInstrument?.bankName || "N/A",
          upi_id: paymentData.paymentInstrument?.upiTransactionId || "N/A",
          payer_name: paymentData.paymentInstrument?.payerName || "N/A",
          payer_mobile: paymentData.paymentInstrument?.payerMobile || "N/A",
          updated_at: new Date().toISOString(),
        })
        .eq("order_id", orderId);

      if (error) throw error;

      return res.redirect(`${FRONTEND_SUCCESS_URL}/${orderId}`);
    }

    res.redirect(FRONTEND_FAILURE_URL);
  } catch (error) {
    console.error("Payment Verification Error:", error.response?.data || error.message);
    res.redirect(`${FRONTEND_FAILURE_URL}?error=verification_failed`);
  }
});

// 🔥 **Fetch Order Details**
app.get("/order/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase.from("orders").select("*").eq("order_id", id).single();

    if (error || !data) throw new Error("Order not found");
    res.json(data);
  } catch (error) {
    console.error("Order Fetch Error:", error);
    res.status(404).json({ error: error.message });
  }
});

// 🔥 **Start Server**
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
