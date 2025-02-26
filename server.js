const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(express.json());
app.use(cors());

// ✅ Production Credentials
const MERCHANT_KEY = "b3ac0315-843a-4560-9e49-118b67de175c";
const MERCHANT_ID = "M22PU06UWBZNO";
const MERCHANT_BASE_URL = "https://api.phonepe.com/apis/hermes/pg/v1/pay";
const MERCHANT_STATUS_URL = "https://api.phonepe.com/apis/hermes/pg/v1/status";

const successUrl = "https://uwcindia.in/payment-success";
const failureUrl = "https://uwcindia.in/payment-failure"; // Redirect URL for failed payments

// Supabase client
const supabase = createClient(
  "https://pvtuhceijltezxhqibrv.supabase.co", // Your Supabase URL
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB2dHVoY2Vpamx0ZXp4aHFpYnJ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Mzk0Njk1MzMsImV4cCI6MjA1NTA0NTUzM30.kw49U2pX09mV9AjqqPMbipv2Dv6aSttqCXHhJQlmisY" // Your Supabase Anon Key
);

// Create a new payment order
app.post("/create-order", async (req, res) => {
  try {
    const { name, mobileNumber, amount, address, service } = req.body;

    // Validate required fields
    if (!name || !mobileNumber || !amount || !address || !service) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const orderId = uuidv4(); // Generate a unique order ID

    // Save order details to Supabase
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
          status: "pending", // Default status
        },
      ])
      .select()
      .single();

    if (orderError) {
      console.error("Error saving order to Supabase:", orderError);
      return res.status(500).json({ error: "Failed to save order details" });
    }

    // Prepare payment payload for PhonePe
    const paymentPayload = {
      merchantId: MERCHANT_ID,
      merchantUserId: name,
      mobileNumber: mobileNumber,
      amount: amount * 100, // Convert to paisa
      merchantTransactionId: orderId,
      redirectUrl: `${redirectUrl}?orderId=${orderId}`, // Redirect to success page with orderId
      redirectMode: "POST",
      paymentInstrument: {
        type: "PAY_PAGE",
      },
    };

    // Generate checksum for PhonePe API
    const payload = Buffer.from(JSON.stringify(paymentPayload)).toString(
      "base64"
    );
    const keyIndex = 1;
    const string = payload + "/pg/v1/pay" + MERCHANT_KEY;
    const sha256 = crypto.createHash("sha256").update(string).digest("hex");
    const checksum = sha256 + "###" + keyIndex;

    // Make API request to PhonePe
    const options = {
      method: "POST",
      url: MERCHANT_BASE_URL,
      headers: {
        accept: "application/json",
        "Content-Type": "application/json",
        "X-VERIFY": checksum,
      },
      data: {
        request: payload,
      },
    };

    const response = await axios.request(options);

    if (response.data.success && response.data.data.instrumentResponse) {
      console.log(
        "✅ Payment URL:",
        response.data.data.instrumentResponse.redirectInfo.url
      );
      return res.status(200).json({
        msg: "OK",
        url: response.data.data.instrumentResponse.redirectInfo.url,
      });
    } else {
      console.error("❌ Payment initiation failed", response.data);
      return res.status(500).json({ error: "Failed to initiate payment" });
    }
  } catch (error) {
    console.error(
      "❌ Error in payment:",
      error.response?.data || error.message
    );
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Handle successful payment
app.post("/payment-success", async (req, res) => {
  try {
    const { orderId } = req.query;

    if (!orderId) {
      return res.status(400).json({ error: "Order ID is required" });
    }

    // Update order status to "success" in Supabase
    const { data: updatedOrder, error: updateError } = await supabase
      .from("orders")
      .update({ status: "success" })
      .eq("id", orderId)
      .select()
      .single();

    if (updateError) {
      console.error("Error updating order status:", updateError);
      return res.status(500).json({ error: "Failed to update order status" });
    }

    // Redirect to the frontend success page with payment details
    res.redirect(
      `https://uwcindia.in/payment-success?orderId=${orderId}&name=${encodeURIComponent(
        updatedOrder.name
      )}&phone=${encodeURIComponent(
        updatedOrder.phone
      )}&address=${encodeURIComponent(
        updatedOrder.address
      )}&service=${encodeURIComponent(updatedOrder.service)}&amount=${
        updatedOrder.amount
      }`
    );
  } catch (error) {
    console.error("❌ Error handling payment success:", error);
    res.status(500).json({ error: "Failed to handle payment success" });
  }
});

// Handle failed payment
app.post("/payment-failed", async (req, res) => {
  try {
    const { orderId, errorMessage } = req.query;

    if (!orderId) {
      return res.status(400).json({ error: "Order ID is required" });
    }

    // Update order status to "failed" in Supabase
    const { data: updatedOrder, error: updateError } = await supabase
      .from("orders")
      .update({ status: "failed" })
      .eq("id", orderId)
      .select()
      .single();

    if (updateError) {
      console.error("Error updating order status:", updateError);
      return res.status(500).json({ error: "Failed to update order status" });
    }

    // Redirect to the frontend failed payment page with error details
    res.redirect(
      `https://uwcindia.in/payment-failed?orderId=${orderId}&error=${encodeURIComponent(
        errorMessage || "Payment failed due to an error"
      )}`
    );
  } catch (error) {
    console.error("❌ Error handling payment failure:", error);
    res.status(500).json({ error: "Failed to handle payment failure" });
  }
});

// Check payment status
app.post("/status/:id", async (req, res) => {
  try {
    const merchantTransactionId = req.params.id;

    if (!merchantTransactionId) {
      return res.status(400).json({ error: "Transaction ID is required" });
    }

    // Generate checksum for PhonePe status API
    const keyIndex = 1;
    const string =
      `/pg/v1/status/${MERCHANT_ID}/${merchantTransactionId}` + MERCHANT_KEY;
    const sha256 = crypto.createHash("sha256").update(string).digest("hex");
    const checksum = sha256 + "###" + keyIndex;

    // Make API request to PhonePe
    const options = {
      method: "GET",
      url: `${MERCHANT_STATUS_URL}/${MERCHANT_ID}/${merchantTransactionId}`,
      headers: {
        accept: "application/json",
        "Content-Type": "application/json",
        "X-VERIFY": checksum,
      },
    };

    const response = await axios.request(options);

    if (response.data.success) {
      return res.redirect(successUrl);
    } else {
      return res.redirect(failureUrl);
    }
  } catch (error) {
    console.error("❌ Error checking payment status:", error);
    res.status(500).json({ error: "Failed to check payment status" });
  }
});

// Start the server
app.listen(8000, () => {
  console.log("✅ Server is running on port 8000");
});
