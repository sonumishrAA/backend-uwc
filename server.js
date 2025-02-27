import express from "express";
import axios from "axios";
import crypto from "crypto";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { createClient } from "@supabase/supabase-js";

const app = express();

app.use(express.json());
app.use(cors());

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// PhonePe credentials
const MERCHANT_KEY = process.env.MERCHANT_KEY;
const MERCHANT_ID = process.env.MERCHANT_ID;
const MERCHANT_BASE_URL = "https://api.phonepe.com/apis/hermes/pg/v1/pay";
const redirectUrl = "https://uwcindia.in/payment-success";

// Create payment order
app.post("/create-order", async (req, res) => {
  try {
    const { name, mobileNumber, amount, address, service } = req.body;

    if (!name || !mobileNumber || !amount || !address || !service) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const orderId = uuidv4();

    // Save order to Supabase
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .insert([
        {
          id: orderId,
          name,
          phone: mobileNumber,
          address,
          service,
          amount,
          status: "pending",
        },
      ])
      .select()
      .single();

    if (orderError) {
      console.error("Error saving order:", orderError);
      return res.status(500).json({ error: "Failed to save order" });
    }

    // Prepare PhonePe payload
    const paymentPayload = {
      merchantId: MERCHANT_ID,
      merchantUserId: name,
      mobileNumber: mobileNumber,
      amount: amount * 100, // Convert to paisa
      merchantTransactionId: orderId,
      redirectUrl: `${redirectUrl}?orderId=${orderId}`,
      redirectMode: "POST",
      paymentInstrument: {
        type: "UPI_QR_CODE",
      },
    };

    // Generate checksum
    const payload = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    const keyIndex = 1;
    const string = payload + "/pg/v1/pay" + MERCHANT_KEY;
    const sha256 = crypto.createHash("sha256").update(string).digest("hex");
    const checksum = sha256 + "###" + keyIndex;

    // Make API request to PhonePe
    const response = await axios.post(MERCHANT_BASE_URL, {
      request: payload,
    }, {
      headers: {
        "Content-Type": "application/json",
        "X-VERIFY": checksum,
      },
    });

    if (response.data.success && response.data.data.instrumentResponse) {
      return res.status(200).json({
        msg: "OK",
        url: response.data.data.instrumentResponse.redirectInfo.url,
      });
    } else {
      console.error("Payment initiation failed:", response.data);
      return res.status(500).json({ error: "Failed to initiate payment" });
    }
  } catch (error) {
    console.error("Error in payment:", error.response?.data || error.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Start server
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
